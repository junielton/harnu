# T450 — Secret scrubber: secrets never reach the model or the transcript

**Status:** specified (not implemented) · **Date:** 2026-10-09 · **Card:** T450 · **ADR:**
[`ADR-draft.md`](ADR-draft.md) (proposed; numbered when merged)

Files:

- this spec;
- [`01-detection.md`](01-detection.md): the rules, the false-positive strategy, the allowlist and the
  measurements (U-1);
- [`02-prototype.md`](02-prototype.md): the prototype mod's source, `claude plugin validate`, `tsc`,
  the audit chips;
- [`03-tests.md`](03-tests.md): its tests and `claude plugin test` output;
- [`04-live-runs.md`](04-live-runs.md): the live runs and the build log.

**Round 2 (2026-10-09).** This revision answers the round-1 verification. The fixes:

- errored results stored raw;
- silent Edit/Write resolution;
- the vault lost on resume;
- the blast radius of failing closed;
- the round trip of a resolved value;
- MOD-9 staging order;
- the companion's real blockers;
- public-material false positives;
- the #92533 evidence;
- six low findings.

Each fix is in place below; §16 lists where.

## 0. Summary

A mod that redacts secrets in every row the conversation keeps, before the model reads the row and
before the transcript file stores it. Every row goes through `session.append`: a tool result, a Bash
output, a pasted prompt, a subagent's row. The mod hands the engine that row with each secret replaced
by a stable placeholder such as `[REDACTED:github-token#fc55a4b6]`. Harnu's session digests, previews
and project memory read the transcript, so they inherit a clean one.

What this spec decides:

1. **Three hooks, not one.** `session.append` alone leaves a secret on disk in two places: in the
   tool's structured record (`toolUseResult`), and in the errored call's stored text. A `tool.call`
   hook closes both. For a normal result it answers with a scrubbed result. For an errored one it
   denies, with the redacted text as the reason; core refuses a hook's own errored answer. Live runs
   prove both. A `prompt.submit` rewrite narrows the prompt's queue record (§5).
2. **Some leaks stay open, and the spec names them.**
   - A large tool output is persisted to `tool-results/` before any hook sees it.
   - The queue record of a `-p` prompt holds the prompt as typed.
   - Images and PDFs are not read.
   - The screen may show a row before its rewrite (§5.3).
3. **Placeholders resolve only where the person agreed.**
   - **Edit/Write:** never into a tracked file; silently into a gitignored file or one the repo lists;
     after a question for any other path.
   - **Bash:** only after a question.
   - **Nobody to ask:** nothing runs.
   - **A placeholder whose value this session no longer holds** (after a resume, a Harnu park or a
     reload): the call is refused, and re-reading the source brings the value back (§6).
4. **Fail-closed for safety, fail-open for bookkeeping, with a way out.** A scrub that fails withholds
   the row, drops the prompt or withholds the result. A count that fails to update changes nothing.
   Because the mod is on by default and hooks every tool, a scrub bug would stall every Harnu session.
   So there is a circuit breaker that tells the person, and two live off switches that reach running
   sessions: `/scrub off`, and Harnu's Settings toggle (§9).
5. **Packaging: a new standalone mod that Harnu bundles and stages,** not code inside the Harnu mod.
   The Harnu mod's own rules forbid what the scrubber needs: MOD-3 and SEC-9(d) ban a Bash `tool.call`
   matcher, and MOD-2 makes every hook fail open (§8, [`ADR-draft.md`](ADR-draft.md)).
6. **Disclosure is a count, never a value.** The status line reads `3 redacted`, `/scrub` lists counts
   by rule, and Harnu reads the same count from `$.state`. A mod cannot write telemetry at all (§7).
7. **Default on** in sessions Harnu starts, except the statistical `high-entropy` rule. That rule stays
   off until W0 measures it on real tool output (§9.1, [`01-detection.md`](01-detection.md) §5).

## 1. Origin and scope

The source is ideas 2 ("Secret-leak redactor") and 70 ("Secret scrubber on the transcript door") of
the operator's ideation report. The report is `.harnu/out/claude-code-mods-ideas.md` in the main
checkout, outside the repo. Both ideas describe the same mod. Idea 104 (the streamer overlay's
redaction layer) is in the same cluster and is out of scope.

Two corrections to the ideas, from this build's types:

- **Idea 2 says `$.ui.notice "2 secrets redacted"`.** `$.ui.notice` is "one line under the dialog open
  for `tool_use_id`", refused when no call is open (`d.ts:2334-2346`). The status line is `$.ui.status`
  (`d.ts:2466-2477`).
- **Idea 70 says `telemetry.log count-only`.** A mod cannot write telemetry at all. A first-party row
  is queued "for built-ins and the engine alone", and a collector record reaches the collector "only
  when the engine raised it" (`d.ts:3129-3135`). `$.telemetry.mark` is likewise served by built-ins
  alone (`d.ts:3149-3155`).

**In scope:**

- the detection rules;
- the hooks, and what each one closes;
- the leaks that stay open;
- the opt-out and resolution design;
- disclosure, packaging, control and failure;
- the Harnu-side work;
- a prototype that runs.

**Out of scope:**

- code under `src/`, `resources/` and `tests/`;
- changes to the Harnu mod's waves;
- OCR of images;
- redacting the operator's existing transcripts at rest (§14, SCR-Q6).

## 2. Conventions

- **Citations.** `ref:N` is line N of `reference.md`, and `d.ts:N` is line N of
  `types/claude-code.d.ts`. The `plugin-authoring` skill wrote both for **Claude Code 2.1.295** on this
  machine; the types file's first line reads `// Written by Claude Code 2.1.295.` `SKILL.md` is that
  skill's loaded text, which is not written to disk.
- **Repo paths** are at `cb7fb58`, the base of this branch.
- **Versions.** The CLI updated itself to **2.1.296** during round 1. Round-2 checks and runs all used
  2.1.296. Each run in [`04-live-runs.md`](04-live-runs.md) names its version.
- **Secret-shaped samples.** No committed file holds a value a secret scanner would flag. The
  prototype's tests build every sample at run time from harmless parts (`'gh' + 'p_' + …`). The spec
  writes a format as broken-up parts: `gh`·`p_` + 36 alphanumerics.
- **Verified** means read in the code or types at the cited line, or shown by a run whose output is
  pasted. **Assumption** marks everything else, and §13 lists each one for the implementation's spike.

## 3. Grounded in the engine (C-1)

Every mechanism the design relies on, where it is declared, and the run that shows it works.

| Mechanism                                              | Declared at                                                                                                                          | Shown by                                                         |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| `session.append` is every row's append                 | `ref:137`; event doc `d.ts:4348-4359`                                                                                                | live run A2 (04 §1.1)                                            |
| Rewrite `content` with `next({ ...e, message })`       | `ref:141`; `SessionAppendMessage.content` `d.ts:10630-10637`                                                                         | tests `session.append > …`; run A2                               |
| `door`, `origin`, `uuid`, `agentId` are pinned         | `ref:139`; `d.ts:10572-10593`                                                                                                        | the prototype passes them through unchanged                      |
| A row the engine appends is never refused              | `ref:141`; `SessionAppendResult` `d.ts:10665-10690`                                                                                  | test `failure > a row the scrubber cannot check …`               |
| `.catch` answers in a failed hook's place              | `Registration.catch` `d.ts:9314-9340`; `ref:79`; the `session.append` example `ref:147-150`                                          | tests `failure > …`; `resolution > with nobody to answer …`      |
| Hook budget 10 s, `.catch` grace 1 s                   | `HookBudget` `d.ts:5100-5117`                                                                                                        | 1 MB scanned in 57 ms (01 §5)                                    |
| What is "stored as made"                               | `ref:143`; `SessionAppendInput` doc `d.ts:10558-10565`                                                                               | run B: `toolUseResult` raw (04 §1.2)                             |
| A `tool.call` answer is recorded as the result         | `ToolCallResult.result` `d.ts:12718-12726`                                                                                           | runs A2 and E: `toolUseResult` scrubbed                          |
| An errored result: core sets it, a deny undoes nothing | `isError` "set by core" `d.ts:12762-12771`; deny after the tool ran `d.ts:12702-12709`                                               | run E: answering is refused, denying is clean (04 §1.4)          |
| `prompt.submit` rewrites the prompt                    | `d.ts:4092-4103`; "pastes already expanded" `d.ts:9052-9054`                                                                         | test `when the person means it > …`; interactive run (04 §1.3)   |
| Status line, toast                                     | `$.ui.status` `d.ts:2466-2477`; `$.ui.toast` `d.ts:2431-2447`                                                                        | interactive run; test `three failures in a row …`                |
| Ask the person                                         | `$.ui.ask` `d.ts:2415-2430` (rejects in `-p`, `:2421`)                                                                               | tests `resolution > …`                                           |
| Run `git` on the host                                  | `$.process.run` `d.ts:3498-3516` ("Git runs with repo hooks off")                                                                    | tests `resolution > into a tracked file …`, `… gitignored …`     |
| A notice row the model never reads                     | `$.session.append` `d.ts:2890-2901`; `SessionAppendArgs` `d.ts:10533-10550`                                                          | test `/scrub off … leaves a notice`                              |
| A timer that outlives a dispatch; a file check         | `$.clock.every` `d.ts:3456-3464`; `$.fs.exists` `d.ts:3268`; `$.plugin.root` `d.ts:2319-2328`; work outside a dispatch `ref:152-160` | test `Harnu's flag file turns a running session off …`           |
| Per-session state any plugin reads                     | `$.state` `d.ts:3376-3417` ("Any plugin reads any value", `:3381`)                                                                   | test `counts … another plugin reads them` (an inline plugin)     |
| Per-plugin store across sessions                       | `$.store` `d.ts:3351-3375`                                                                                                           | the salt persisted: the same placeholder in runs A2, E and R1–R5 |
| Read the repo's config file                            | `$.fs.read` `d.ts:3223-3241` (4 MiB cap)                                                                                             | tests `repo config > …`, `resolution > … resolveInto …`          |
| Slash command                                          | `$.command.register` `d.ts:3091`; `CommandRunInput` `d.ts:1792-1819`; `CommandRunResult` `d.ts:1837-1872`                            | tests `/scrub keep-next`, `/scrub off`                           |
| `userConfig` options, and a change reloads             | `PluginOptions` `d.ts:7646-7658`; `pluginConfigs` `ref:74`                                                                           | `claude plugin validate` accepts the manifest (02 §2.5)          |
| A reload empties module variables                      | `ref:72` ("`register` runs again in a fresh environment"); SKILL.md ("the module's own variables start over")                        | resume run R3 (04 §1.5), the same effect from a new process      |
| SHA256 in the module                                   | global `crypto.subtle.digest` `d.ts:14860-14869` (no HMAC: `digest` only)                                                            | every placeholder test                                           |
| Tiers and where a plugin sits                          | `TIERS` `d.ts:12592-12610`                                                                                                           | not run: §13 A-1                                                 |
| Test kit: `mock.session`, inline plugins, `options`    | `d.ts:15469-15480`, `15549-15564`, `15939-15954`; `ref:81`                                                                           | 63 tests (03 §2)                                                 |
| Plugin dirs for staging                                | `--plugin-dir`, `CLAUDE_CODE_PLUGIN_DIRS` `ref:72`                                                                                   | every live run used `--plugin-dir`                               |

Two gotchas the C-5 brief named, and how the prototype avoids them:

- `$` is always written `$.noun.event(...)`. Even an inline test plugin must name its `$.state` key as
  a literal. `claude plugin test` refused `$.state.get(counts)` from an inline plugin with "takes a
  reference whose plugin and key are string literals" (04 §2).
- Every `$` call the plugin makes has a stub. The kit's `session.start` bottom needs `{ cwd }`. The
  first run failed with "next() passed an argument with no { cwd }" until the test's
  `on('session.start')` answered it. Round 2's tests also stub `process.run`, `ui.toast`, `fs.exists`
  and `AskUserQuestion` (03 §1).

## 4. Detection (U-1)

[`01-detection.md`](01-detection.md) holds the full set. In brief:

- **Eighteen rules.**
  - Twelve provider formats: AWS, GitHub classic and fine-grained, GitLab, Slack token and webhook,
    Stripe, Anthropic, OpenAI, Google, npm and SendGrid.
  - Three structural: the PEM private-key block, JWT, and `scheme://user:PASSWORD@host`.
  - Two contextual: an `Authorization:` header, and a `NAME=value` / `"name": "value"` whose name ends
    in a secret word.
  - One statistical: `high-entropy`, for unlabelled tokens.
- **A value seen once is caught everywhere after.** Before any rule runs, the scrubber replaces every
  value already in this session's vault by its placeholder. A contextual rule misses a value echoed in
  a new context (`the password is …`); the literal match does not (test `a value seen once is caught
by its literal in a new context`).
- **False positives are filtered by shape before entropy is measured.** Dropped before entropy is
  measured:
  - hex digests and git SHAs, UUIDs;
  - lockfile `sha512-` values, `go.sum` `h1:` hashes;
  - `data:…;base64,` assets and CSP nonces;
  - publishable `pk_` keys and SSH public keys;
  - the body of a certificate or public-key PEM block;
  - identifiers, paths, words and kebab slugs.

  A tool record's `base64` media bytes are never scanned.

- **Allowlist.** A committed `.claude/secret-scrubber.json` lists SHA256 digests of values the repo
  declares harmless, never the values themselves. It can also turn off whole rules, and name the paths
  a resolved value may be written into (§6.2).
- **The statistical rule is off by default.** At 4.0 bits per character it hits 4 times in this
  repo's 26.4 MB of tracked text, all false positives. It catches 99.5% of random 32-character base62
  and base64url tokens, but only about 76% of standard base64 ones. Round-1 probes on real tool output
  also hit an opaque `session_…` id and a standalone certificate line. A repo is not a transcript, so
  W0 measures real tool output before it is turned on (01 §5).
- **The test matrix:** 19 positives (every rule, plus a second assignment shape) and 22 negatives, run
  by `claude plugin test`. The real output is in [`03-tests.md`](03-tests.md) §2.

## 5. Doors and leaks, honestly (U-2)

### 5.1 Every door the mod rewrites

`session.append` is raised once per row "as the row's originator" (`ref:137`), and `door` names the
route (`d.ts:10556`). The mod hooks the event with no matcher, so every door below goes through it. It
rewrites text blocks and each `tool_result`'s `content` (`ref:141`, `d.ts:10633-10636`).

| Door           | What arrives there (`ref:137`, `d.ts:10556`)                          | The mod                                                                                                                     |
| -------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `prompt`       | the person's prompt, pastes already expanded (`d.ts:9052-9054`)       | scrubbed here and, earlier, at `prompt.submit` (§5.2)                                                                       |
| `command`      | a slash command's record and output                                   | text blocks scrubbed                                                                                                        |
| `response`     | each block of the model's response                                    | text blocks scrubbed; thinking and `tool_use` are pinned (§5.3, L7)                                                         |
| `tool-result`  | a tool's result                                                       | `tool_result.content` scrubbed (a string, or nested text blocks)                                                            |
| `tool-message` | rows a tool hands over beside its result                              | text blocks scrubbed                                                                                                        |
| `delivery`     | a prompt or notification folded into a running turn, a peer's message | text blocks scrubbed                                                                                                        |
| `attachment`   | reminders and listings the engine injects                             | text blocks scrubbed; "a rewrite of an attachment rendered per request or carrying media keeps the row as made" (`ref:141`) |
| `hook-context` | a settings hook's or a chain's context                                | text blocks scrubbed                                                                                                        |
| `note`         | a plugin's own `$.session.append`                                     | scrubbed, except the scrubber's own rows                                                                                    |
| `compaction`   | a compaction's boundary and summary                                   | scrubbed; a summary written from scrubbed rows holds only placeholders                                                      |
| `notice`       | the notices the transcript shows                                      | text blocks scrubbed                                                                                                        |

The same holds in every subagent's conversation, because `agentId` names the loop (`ref:137`,
`d.ts:10587-10593`). A subagent's tool calls also go through the mod's `tool.call` hook: the round-2
marker run shows the hook on all three of an isolated subagent's Bash calls (04 §1.6).

### 5.2 The two other hooks, and what each closes

**`tool.call`, after `next`: the tool's structured record.** `ref:143` says "a tool result's
structured record beside its tool_result (`toolUseResult`, what the screen draws) … [is] stored as
made". The mod answers the call with `{ result: scrubbed, context }`, and core "records it in the
transcript as the tool's result" (`d.ts:12722-12725`). A deep scrub of every string in the result,
skipping `base64` media bytes, therefore reaches `toolUseResult`.

**`tool.call`, after `next`: an errored result.** For a call that errored (a non-zero Bash exit, a
thrown tool), core stores the error text as `toolUseResult` and sets `isError` itself
(`d.ts:12762-12771`). A hook cannot answer an errored result: run E's variant that tried
(`{ isError: true, result: <scrubbed> }`) was refused by core with "does not match its output shape …
expected object, received string". When the error text holds a secret, the mod therefore **denies**,
and the deny text is the redacted output:

```text
the call ran and failed; its output, redacted:
Exit code 3
API_SECRET=[REDACTED:secret-assignment#d19da717]
…
```

The tool already ran, and a deny "undoes nothing" (`d.ts:12706-12708`). So the text says it ran, and
the model keeps everything it needs. An errored result with no secret passes untouched.

Live, same fixture file, `cat fixture.env` (and `…; exit 3` for E):

| Run                                     | `message.content` of the tool row | `toolUseResult`                        |
| --------------------------------------- | --------------------------------- | -------------------------------------- |
| B: `session.append` hook only (2.1.295) | placeholders                      | **raw** (`api_secret`, `github` found) |
| A2: all three hooks (2.1.296)           | placeholders                      | placeholders                           |
| E, round-1 prototype, exit 3 (2.1.296)  | placeholders                      | **raw**: the round-1 gap               |
| E, final prototype, exit 3 (2.1.296)    | placeholders, inside the deny     | placeholders                           |

**`prompt.submit`: the prompt before it is queued.** `ref:143` says the queue's own record of a prompt
"is no row of the conversation: a plugin that must change a prompt's words everywhere rewrites them at
`prompt.submit`, before they are queued". The rewrite also changes what the screen shows ("the user
message on screen follows", `d.ts:4096`). The interactive run showed the placeholder in the person's
own row (04 §1.3). It did not close the `-p` case, though (L2 below).

### 5.3 Where a secret still lands, and what would close it

Each line is a path a secret can take to disk or to the model, with its status, evidence and fix.

| #   | Where the secret lands                                                                                                                                                                                                                                       | Evidence                                                                                                                                                                                                                     | Status, and what would close it                                                                                                                                                                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L0  | **An errored call's stored text.** Every non-zero Bash exit, every tool that throws, stores its error text as `toolUseResult` (`d.ts:12767-12771`).                                                                                                          | Run E, round-1 prototype: `toolUseResult` raw, `message.content` scrubbed. A verifier found it first, live on 2.1.296.                                                                                                       | **Closed** by §5.2's deny. Run E, final prototype: clean.                                                                                                                                                                                                                                                                    |
| L1  | **A large tool output, persisted whole.** Bash output past the inline cap is written to `<transcript dir>/<session>/tool-results/<id>.txt`. The row carries a 2 KB preview and the path (`persistedOutputPath`, `d.ts:20394`; `rawOutputPath` `d.ts:20366`). | Run A2: a 233 KB `big.log` with the secret at its end. The `tool-results/*.txt` file holds the raw `API_SECRET`. The row and `toolUseResult` hold none.                                                                      | **Open.** It needs an engine change, since the file is written before `tool.call` returns. Until then, Harnu's main process can rewrite the file in place once the row lands (W4, a race the spike must measure). The model never reads it unless it `Read`s the path, and that read is scrubbed.                            |
| L2  | **The `-p` prompt's queue record.** A headless prompt's `queue-operation` `enqueue` entry holds the prompt as typed, even with the `prompt.submit` rewrite.                                                                                                  | Runs A2 and B: entry 0 (`queue-operation`/`enqueue`) holds the raw key. An interactive prompt typed while idle wrote no `queue-operation` entry (interactive run). A prompt typed mid-turn was **not** reproduced (§13 A-4). | **Open.** A session Harnu dispatches gets its starting prompt as a `claude` argv positional (`docs/harnu-features.md`), which may take the same path (§13 A-4). Harnu lints every boot prompt it builds from a card (`buildDispatchPrompt`, §11). The general fix is the engine's: raise `prompt.submit` before the enqueue. |
| L3  | **Image and document blocks.** A screenshot of a key, or a PDF that holds one. An image or document block "may be dropped or moved, not changed or added" (`ref:141`, `d.ts:10633-10635`), and an attachment carrying media "keeps the row as made".         | Types only.                                                                                                                                                                                                                  | **Open.** Dropping the block loses the image. OCR is out of scope (SCR-Q5).                                                                                                                                                                                                                                                  |
| L4  | **The screen before the rewrite.** "The screen, an SDK stream or Remote Control may show the row just before its rewrite; the model and the transcript file never read that form" (`d.ts:4352-4355`).                                                        | Types only.                                                                                                                                                                                                                  | **Open,** with no fix in a mod. It is not stored and not sent to the model; a screen share or recording would see it.                                                                                                                                                                                                        |
| L5  | **Plugins above the scrubber.** A plugin whose `session.append` hook runs before the scrubber's sees the raw row. Same-tier mods are not isolated from each other (ADR-0018 `:42-44`).                                                                       | Tier order: `d.ts:12592-12610`. Order inside the `user` tier is not documented (§13 A-1).                                                                                                                                    | **Open.** An organization seats the scrubber at the `prepend` tier (managed settings). Harnu stages it second, right after the Harnu mod (§8.3), which hooks no `session.append` and no `tool.call`.                                                                                                                         |
| L6  | **Collector telemetry.** The engine's own OpenTelemetry records, when the operator configured a collector that logs prompts or tool details.                                                                                                                 | `telemetry.log` with `to: 'collector'` is hookable, and its content is rewritable (`d.ts:4278-4289`, `d.ts:12375-12386`). First-party rows carry no free text (`TelemetryChoice`, `d.ts:12354-12363`).                       | **Open.** W6, optional: a `telemetry.log { to: 'collector' }` hook that scrubs string attributes. The prototype does not hook it.                                                                                                                                                                                            |
| L7  | **Thinking blocks and `tool_use` input.** The bottom puts these back "whole and in place" (`ref:141`).                                                                                                                                                       | Types only.                                                                                                                                                                                                                  | **Narrow by design.** The model only ever saw placeholders, so it can only write a raw value it inferred. With `/scrub keep-next` it saw the raw value on purpose (§6.3).                                                                                                                                                    |
| L8  | **What the engine stores on its own** as made: "the row's timestamps and parent links, and an attachment's payload" (`ref:143`), and the engine's later edits of a kept row (`ref:141`).                                                                     | Types only. Run A2's audit found no raw value in any `attachment` entry (04 §1.1).                                                                                                                                           | **Watched.** The spike re-audits with an `@`-mentioned `.env` file, an attachment payload (§13 A-5).                                                                                                                                                                                                                         |
| L9  | **Before the mod loads, and outside it.** A session started without the mod (`claude` outside Harnu, the mod off), a `--resume` of an old transcript ("loads are not appends", `ref:137`), and every transcript written before the mod existed.              | By construction.                                                                                                                                                                                                             | **Open.** §8.3 covers outside Harnu; old transcripts are SCR-Q6.                                                                                                                                                                                                                                                             |
| L10 | **A copy the scrubber itself writes.** A resolved placeholder puts the real value into a file (§6.2).                                                                                                                                                        | By design: test `resolution > …`; run R4/R5 (04 §1.5).                                                                                                                                                                       | **Bounded by the resolution policy** (§6.2): never a tracked file, silently only a gitignored or listed one, anything else after a question.                                                                                                                                                                                 |

Harnu's readers inherit what is clean:

- `claude-reader.ts` reads `firstPrompt` from user rows (`:895-905`).
- `transcript-truth.ts` reads titles from `last-prompt` (`:218-240`). Run A2's `last-prompt` entries all
  hold the placeholder.
- No reader in `src/` reads `toolUseResult` or `queue-operation`: a grep for both returns no hits. So
  L2's raw prompt reaches no Harnu surface today.

## 6. When the person means it (U-3)

### 6.1 What the model sees

The model sees `[REDACTED:<rule>#<tag>]`. The tag is the first 8 hex characters of
SHA256(salt + value). The salt is a random UUID the mod keeps in `$.store`, one per install (02 §2.4).
It gives the model three things to reason about:

- **Kind.** The rule says what the value was: `stripe-secret-key`, `secret-assignment`. In the
  interactive run the model answered "it's a live Stripe secret" from the rule name alone (04 §1.3).
- **Identity.** The same value gives the same placeholder in every row and every session on this
  machine (test `the same value gets the same placeholder`). Runs A2, E and R1–R5 all read `#d19da717`
  for the fixture's `API_SECRET`. The model can tell that two rows hold the same secret, and that a
  rotated key is a different one.
- **No value.** A digest of a high-entropy key reveals nothing practical. The salt keeps a
  low-entropy password in a connection string from being matched against a dictionary of known
  digests. `crypto.subtle` offers `digest` only, not HMAC (`d.ts:14860-14869`), so the tag is a salted
  digest, not a keyed MAC. The tag is not portable across machines, by design. The repo allowlist uses
  plain SHA256 instead (§4).

### 6.2 The model needs the real value: resolution

The mod keeps this session's placeholder → value table in a **module variable**, the vault. It is
never kept in `$.state`, which every plugin reads (`d.ts:3381`), or in `$.store`, which is written to
disk.

**The scrubber is not an exfiltration control, and this policy does not pretend to be one.** A Bash
command can read any file on the machine with or without the mod (`curl --data @.env`). What the
policy controls is narrower: that the scrubber itself never creates a **new copy** of a secret
somewhere the person did not agree to. A silent copy could later leave by a command that carries no
placeholder and so triggers no question, whether the model's own idea or a prompt injection's.

| A call carries a placeholder, into …                                                 | What the mod does                                                                                                                                                           | Why                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Edit`/`Write`/`NotebookEdit` on a **tracked** file                                  | **Refuses**, and nothing is written: "is tracked by git, and a secret is never written into a tracked file". Checked with `git ls-files --error-unmatch` (`$.process.run`). | A tracked file is one `git commit && git push` away from a remote. Resolving there would publish the secret; writing the placeholder's text would corrupt the file.                   |
| `Edit`/`Write`/`NotebookEdit` on a **gitignored** file                               | Puts the real value back with no question (`git check-ignore -q`), and tells the model so in the result's `context`.                                                        | Ignored files are where secrets already live (`.env`, `*.local`). Editing a `.env` the model has read must keep the real value, or the file breaks.                                   |
| `Edit`/`Write`/`NotebookEdit` on a path the repo lists in `resolveInto`              | Same as gitignored.                                                                                                                                                         | The repo's own word for a secrets file that is not ignored (`.claude/secret-scrubber.json`, 01 §4).                                                                                   |
| `Edit`/`Write`/`NotebookEdit` on **any other path** (`/tmp/x`, a new untracked file) | **Asks**: "Write the real value of … into <path>?", with "Allow once" or "Keep redacted". "Keep redacted" writes nothing.                                                   | A new copy where nobody expects one is the exfiltration staging step the verifier described (`/tmp/x`, then `curl --data @/tmp/x`).                                                   |
| `Bash`                                                                               | **Asks**: "Let this Bash command use the real value of …?" "Allow once" resolves. "Keep redacted" runs the command with the placeholder text: the person's choice.          | A command can send a value off the machine. The person decides each time.                                                                                                             |
| Any of the above, **with nobody to ask**                                             | **Refuses**: "could not resolve the placeholders in this call (nobody to ask, or the question failed). Nothing ran." (`.catch`, test `with nobody to answer …`)             | In `-p` and in unattended sessions `$.ui.ask` rejects (`d.ts:2421`). Before round 2 the `.catch` then ran the call with the placeholder's text, which writes the literal into a file. |
| Any tool, a placeholder **this session does not hold**                               | **Refuses** (§6.4).                                                                                                                                                         | Its value is gone with the process. Writing the literal corrupts the file without a visible failure.                                                                                  |
| Any other tool (MCP, `WebFetch`, …)                                                  | Nothing. The placeholder stays.                                                                                                                                             | These reach other machines.                                                                                                                                                           |

**The trade, stated.** "Silently into a gitignored file" still lets an injected instruction copy a
secret into an ignored path that is not a secrets file (a `build/` dir, a `*.log` the repo ignores),
then send it with a command that names no placeholder. That copy adds nothing a command could not
already do with the original file, when the value came from a file. It does add something when the
value came from a paste or a command's output. SCR-Q3 asks whether silent resolution should also
require that the value came from **that same file**. That would make "edit my `.env`" silent and
everything else a question.

`userConfig.resolve` (`ask` | `never`, default `ask`) turns Bash resolution off. Edit/Write follow
the table above and cannot be turned off: without resolution, an edit of a secrets file writes the
placeholder's text into it.

**The round trip stays clean.** A command that echoes a resolved value back is scrubbed on its way in.
The vault's literal match catches the value even when no rule would, such as a URL password echoed
bare (test `a value seen once is caught by its literal in a new context`).

### 6.3 The person pastes a key on purpose

The default path needs no escape at all. The model sees the placeholder. The person's next "put it in
`.env`" resolves silently into the ignored file, and a "deploy with it" asks (§6.2). The key never
reaches the model or the transcript, and the session can still use it.

For the rare case where the model must read the literal (a malformed key the person is debugging),
`/scrub keep-next` sends **the next prompt only** through unredacted. Both the `prompt.submit` rewrite
and the prompt row's scrub are skipped. The test `/scrub keep-next lets exactly one prompt reach the
model as typed` proves the second prompt is scrubbed again. The command's own output row records that
the person chose this.

A per-repo escape lives in `.claude/secret-scrubber.json` ([`01-detection.md`](01-detection.md) §4):

- `allow` takes digests of values the repo declares harmless;
- `disable` takes rule ids;
- `resolveInto` takes repo-relative paths a resolved value may be written into without a question.

A broken file logs one line and keeps every rule on. Harnu's per-folder off switch (§9.1) is the
coarse escape, and `/scrub off` the session's.

### 6.4 Resume, Harnu's hibernation, and reloads: the vault is empty

The vault lives in the process. Three things start a new one with the same conversation:

- **Harnu parks a session.** Hibernation kills the `claude` process, and waking the session runs
  `claude --resume`. Only a resumable kind is parkable (`src/main/fleet-policy.ts:66-73`;
  "`--resume` restores the conversation regardless", `:111`). The resumed conversation is full of
  placeholders whose values the new process never saw.
- **A reload.** A `userConfig` change reloads the module (`ref:74`), as does any hot reload. `register`
  runs "in a fresh environment" (`ref:72`), and "the module's own variables start over" (SKILL.md).
- **Any `--resume`** the person runs.

The salt is in `$.store`, which persists, so placeholders stay identical across all three. The design:

- **A call carrying a placeholder the vault does not hold is refused, and nothing runs.** The refusal
  tells the model how to recover: "the value behind [REDACTED:…] is not known in this session (it was
  resumed, parked by Harnu, or the scrubber reloaded). Nothing ran. Read the file or rerun the command
  that held it: the same placeholder comes back with its value." This applies to Edit, Write,
  NotebookEdit and Bash.
- **Recovery is a re-read.** Reading the source again mints the same placeholder, because the salt is
  the same, and fills the vault. The next call resolves.

Live, on a resumed session (04 §1.5):

- R3: the Write is refused and no file is created.
- R4: `cat .env`, then the Write, puts the real value into the ignored `.env.local`.
- R5: the model is told it did so.

Before round 2, a Write with the placeholder only in `content` (or an Edit with it only in
`new_string`) would have written the literal `[REDACTED:…]` into `.env` with no visible failure.

## 7. Disclosure (U-4)

### 7.1 What the person sees

- **Status line.** `$.ui.status("<n> redacted")` after each redaction. The engine prefixes the
  plugin's name: the interactive run drew `⚠ secret-scrubber: 2 redacted` under the prompt (04 §1.3).
  The status also reads `off (/scrub off)` or `failing: /scrub off` (§9).
- **The placeholder in place.** The person's own prompt row shows the placeholder (`d.ts:4096`), so
  they see exactly what was taken.
- **`/scrub`** prints `<n> redacted this session: <rule> <count>, …`, plus `(off: …)` or `(failing)`.
- **A notice when it turns off.** "Secret scrubbing is off for this session (/scrub off)" or "(Harnu
  Settings)" is appended as a notice row: the transcript keeps it, the model never reads it
  (`d.ts:10533-10550`).
- **In Harnu (W3).** The Harnu mod reads `secret-scrubber.counts` from `$.state`; the test `counts …
another plugin reads them` shows a second plugin reading it. Harnu shows the count on the session
  row, and on a folder's first redaction posts one Activity notice. A tripped breaker
  (`tripped: true`) posts a notice the operator cannot miss (§9.2).

### 7.2 What the counts hold, and where the tag still appears

The counts are `{ total, byRule: { <rule>: n }, off, tripped }`: rule ids, numbers and two flags,
never a value and never a tag (02 §2.4, `record()`). The test asserts the exact JSON another plugin
reads: `{"total":2,"byRule":{"anthropic-key":1,"private-key":1},"off":false,"tripped":false}`.

The tag is left out of the counts because a count has no use for identity. The tag itself is not
secret-free in every sense, though. It does appear in other places:

- in the transcript;
- in anything written from the transcript, including the session digests Harnu writes to
  `.harnu/memory/`;
- in a committed copy of those digests. `.harnu/` is gitignored in this repo (`.gitignore:43-48`, "local
  by default; opt-in commit"), but a repo may commit its memory.

A committed tag reveals no value, but it lets any reader correlate "the same secret appears in these
two digests", across sessions on that one machine. W3 therefore strips tags when Harnu writes memory
(`[REDACTED:<rule>]`), since memory readers need the kind, not the identity (SCR-Q10).

### 7.3 Telemetry

None. A mod cannot write telemetry (§1: `d.ts:3129-3135`, `3149-3155`). If Harnu ever logs the count
(W3), it logs `{ folderAlias, total, byRule }` only, under the same rule: no value, no tag. The Harnu
mod's own contract already forbids prompt text and secrets in its payloads (`01-contract.md:678` of
T389).

## 8. Packaging (C-3)

### 8.1 Decision

A **new standalone mod, `secret-scrubber`, which Harnu bundles under `resources/scrubber/` and
stages as its own `--plugin-dir`**, right after the Harnu mod. The work is split:

- **Harnu's main process:** staging, the settings, the live off flag, the audit row and the count
  display.
- **The mod:** all scrubbing.

[`ADR-draft.md`](ADR-draft.md) records the decision.

### 8.2 Why not the alternatives

| Option                                        | Why not                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inside the Harnu mod (`resources/companion/`) | Three of its rules forbid what the scrubber needs. **MOD-3** allows `tool.call` only on `Edit`/`Write`/`NotebookEdit` and Harnu's MCP tools: "No matcher may match `Bash` (static test, #92533)" (T389 `00-master.md:524`, risk R8 `:605`). **SEC-9(d)** forbids "Any `tool.call` matcher on Bash" (`00-master.md:502`). **MOD-2** makes every hook return `next(e)` on failure, which is fail-open (`:523`), and the scrubber must fail closed. A fourth difference is not a blocker but a mismatch: the Harnu mod's off/shadow/active modes follow a CLI version gate (`companion-prefs-core.ts:105-117`), and the scrubber's on/off is a privacy choice. (Round 1 also said it "goes dormant without a spawn token". That is wrong: `register.ts:484-491` goes dormant only when the session is tokenless **and** non-interactive.) |
| Harnu main-process code only                  | Main sees a row only after the engine wrote it. By then the model has read the secret and the file has it. Rewriting the JSONL at rest races the engine's appends. Main keeps one job: L1's persisted files (W4).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Folded into T447's `$.harnu` noun mod         | That mod is a typed SDK over Harnu's verbs, and it is never staged in ticks (T447 `00-spec.md:256-296`). A scrubber has no Harnu verb to call, and it must load everywhere.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

**#92533 did not reproduce on 2.1.296 in a run that proves the hook fired.** The bug was the reason
the Harnu mod bans Bash hooks: "a pass-through Bash `tool.call` hook breaks `Agent(isolation:
"worktree")`" (ADR-0018 D6 `:121-126`). The repo's smoke B4 reproduced it on 2.1.287
(`docs/studies/T389-smoke-evidence.md:628-650`).

Round 2's run used a marker variant of the prototype that stamps every Bash result its hook handles.
The run left out user settings, so a shell-rewriting hook could not interfere. The isolated subagent's
three Bash calls ran inside its worktree, on its branch, and wrote nothing to the main checkout. The
subagent's transcript holds the marker on all three results (04 §1.6). A verifier's independent run
on 2.1.296 matched.

Round 1's "B4b" inference is withdrawn: subagent transcripts carry no `toolUseResult` key, so a clean
audit there proved nothing. Still unrun (§13 A-2):

- an interactive session;
- a Scheduler tick;
- an isolated agent's Bash input rewritten after "Allow once".

The Harnu mod's own ban stays as it is.

### 8.3 Where it runs, and in what order

**Order.** MOD-9 says "the companion is the first `--plugin-dir`" (`00-master.md:530`), and
`insertCompanionPluginDir` does it (`staging-core.ts:77-86`). The scrubber goes **second**: right
after the Harnu mod, before every other dir (the bundled skills plugin, any user dir). No MOD-9
amendment is needed. The Harnu mod hooks no `session.append` and no `tool.call`. It does hook
`prompt.submit`, so it sees the raw prompt there, but its contract bars it from carrying prompt text
(`01-contract.md:678`). Ordering within the tier is still A-1.

| Session                                                      | Gets the scrubber?                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interactive, started by Harnu                                | Yes, second among the `--plugin-dir` flags (W2).                                                                                                                                                                                                                                                                                                                                                                                    |
| Agent-dispatched (`create_session`, board/manifest dispatch) | Yes. These sessions are unattended, so `$.ui.ask` has nobody to answer. A call that needs a question is then refused (§6.2), and resolution happens only into ignored or listed files.                                                                                                                                                                                                                                              |
| Scheduler tick                                               | Yes (W2), once the spike confirms #92533 stays closed in a tick. The mod calls no MCP verb and no network. Its process calls are `git ls-files` and `git check-ignore`, and its writes go to `$.store` (the salt) and `$.state` (counts). An `observe` tick has no Edit, Write or Bash, so only the scrub itself runs there.                                                                                                        |
| Outside Harnu                                                | Only if installed, in one of two ways: `/plugin install secret-scrubber --marketplace <owner>/<repo>` (the mod's own marketplace file, `ref:85-97`), or an "Also outside Harnu" switch on its Settings → Mods row, which writes `CLAUDE_CODE_PLUGIN_DIRS` the way the Harnu mod's P4W3 does (`external-install-core.ts:13`). Without either it gets nothing (L9). Harnu's live off flag does not reach it there; `/scrub off` does. |
| An organization's managed seat                               | Install it at the `prepend` tier to sit above every user plugin (L5).                                                                                                                                                                                                                                                                                                                                                               |

## 9. Control and failure (C-4)

### 9.1 On, off, default

- **Default: on** for every session Harnu starts, with the `high-entropy` rule **off** until W0
  measures it on real tool output (§4).
- **Global switch: Settings → Mods, the scrubber's row.**
  - **Off for new sessions:** Harnu stops staging the mod, the way the Harnu mod's kill switch gates
    staging (`spawn-inject.ts:72-96`).
  - **Off for running sessions:** Harnu also writes a flag file, `scrubber-off`, two levels above the
    staged mod dir. Every running scrubber checks it every 5 s (`$.clock.every` + `$.fs.exists`) and
    turns itself off within one check. The test `Harnu's flag file turns a running session off within
one 5 s check` drives it.
  - This reaches every Harnu session, unattended ones and ticks included, with nobody typing anything.
- **Per folder:** the folder's menu offers "Scrub secrets in new sessions" (on by default), resolved at
  spawn like the folder's other spawn-time settings.
- **Inside a running session:**
  - `/scrub off` and `/scrub on`;
  - `/scrub keep-next` (one prompt);
  - the `userConfig` fields from the config menu (`resolve`, `highEntropy`, `entropyThreshold`). A
    change reloads the module (`ref:74`) and so empties the vault (§6.4).
- **Per repo:** `.claude/secret-scrubber.json` (01 §4).

Turning it off is recorded: a notice row in the transcript, `off: true` in the counts, and the status
line.

### 9.2 Failure: what fails closed, what fails open, and the blast radius

**Two kinds of failure.** A failure in the **safety path** (detect, the scrub, resolution) fails
closed. A failure in the **bookkeeping path** (the count in `$.state`, the status line, a toast) fails
open: `record()` catches its own errors, and the row is already scrubbed (test `a failed count write
never withholds a row`).

| Hook             | Safety failure before `next`                                                                                                                                                                                                                                                          | Safety failure after `next`                                                                                                                                                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session.append` | `.catch` calls `next(withheld(e))`: every text block reads `[secret-scrubber failed: text withheld]` and every result `[secret-scrubber failed: result withheld]`. The row cannot be refused (`ref:141`), so it is stored minus its words (test `a row the scrubber cannot check …`). | `next(e)` replays the scrubbed call already made (`ref:79`).                                                                                                                                                                                                                              |
| `prompt.submit`  | `{ drop: 'secret-scrubber could not check this prompt; /scrub off turns it off for this session' }` (`d.ts:4096-4102`).                                                                                                                                                               | Replays.                                                                                                                                                                                                                                                                                  |
| `tool.call`      | A call that carries a placeholder of Edit/Write/NotebookEdit/Bash is **refused** ("could not resolve … Nothing ran."). Any other call runs unchanged: it carries no secret the mod would have resolved.                                                                               | `{ deny: 'the call ran, but secret-scrubber could not check its output, so it is withheld. Do not run it again; ask the person.' }`. The tool **already ran**, and a deny "undoes nothing" (`d.ts:12706-12708`), so the text says so: the model must not repeat a non-idempotent command. |

**The blast radius, plainly.** Several facts compound:

- the mod is on by default;
- it is staged into every Harnu session, unattended ones and ticks included;
- `tool.call` and `session.append` have no matcher.

So a bug in `detect()` or `scrubText()` that throws on common input would, in **every** such session:

- withhold every row: the model reads `[… withheld]` in place of each result;
- drop every typed prompt;
- deny every tool result after the tool ran.

The commands still run, because a deny undoes nothing. Without the "do not run it again" text, a model
that cannot see an outcome tends to retry. Turning the mod off in Settings used to reach only new
sessions.

What bounds it:

1. **A circuit breaker.** Three safety failures in a row trip it. The mod then raises a toast that
   names the way out ("/scrub off turns it off for this session"), sets the status line to `failing:
/scrub off`, and sets `tripped: true` in its counts. Any success resets the count. Harnu relays the
   flag as an operator-facing Activity notice (W3). The breaker **does not** fail open by itself: a
   tripped scrubber that started passing rows would leak exactly when something is wrong. It makes the
   failure loud and the exit one step away (test `three failures in a row trip the breaker`).
2. **Live off switches that reach running sessions:** `/scrub off` for the person, and the Settings
   flag file for the operator (§9.1). Both are tested, and either makes every hook pass rows through as
   they came.
3. **`/scrub off` itself cannot be dropped by the failure.** A slash command runs through `command.run`,
   which the scrubber does not gate. Whether a typed `/scrub off` also passes through `prompt.submit`
   before it reaches `command.run` is A-9.
4. **The bug class is narrow.** The safety path is a pure function over strings (`detect`) and a digest.
   The tests cover every rule and filter, and a property test over random input belongs in W1.

The `.catch` grace is 1 s (`d.ts:5117`), and the handlers do no work beyond building a constant or
scanning the call's input for placeholders. If `session.start` fails (a store error, say), the salt is
left empty. Tags then become plain SHA256 of the value, and the status line reports it (W3, a
"degraded" chip).

`claude plugin validate` reports all three hooks as `gating hook with .catch` (02 §2.5).

### 9.3 Settings → Mods audit chips

Computed with Harnu's own `parseValidateReport` and `buildAnalysis` from `src/main/mods-audit-core.ts`
over the prototype's `claude plugin validate --json`: **`process`, `files`, `prompts`, `tool-calls`**,
and no warnings (02 §3.2). They come from these lines of the code:

- `process.run` (`:376`);
- `fs.read`/`fs.exists` (`:378`);
- `prompt.submit` (`:379`);
- `tool.call` (`:381`).

Two gaps the implementation closes (W3):

- **No chip for rewriting the transcript.** `session.append` is in no table (`:370-393`). Add a
  `transcript` chip, "Rewrites what the conversation keeps", derived from a `session.append` hook. Its
  label needs `design.md` and both locales.
- **`pickPermissionHookers` would list the scrubber.** The filter excludes only `source === 'harnu'`
  (`:748-764`), so a new `'harnu-scrubber'` row source (`:18`) would still be listed as a
  "permission hooker". The fix has two parts. Add `'harnu-scrubber'` to `ModSource`. Change the filter
  to exclude every bundled Harnu source (`'harnu'`, `'harnu-skills'`, `'harnu-scrubber'`), not only
  `'harnu'`.

## 10. Overlap: what exists, what this adds (C-2)

| Existing thing                                                           | Status, checked against the code                                                                                                                                                                            | Relation                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T389 P1W2, mod skeleton and staging (`staging.ts`, `staging-core.ts`)    | Shipped (commit `7446534`).                                                                                                                                                                                 | **Builds on.** W2 reuses the stage-and-insert pattern for a second mod dir, inserted after the Harnu mod's (MOD-9). Nothing new in the Harnu mod.                                                                                                                                                         |
| T389 P4W1, Mods audit tab (`mods-audit-core.ts`)                         | Shipped, parts A and B.                                                                                                                                                                                     | **Extends.** A `transcript` chip, a `harnu-scrubber` row source, and the `pickPermissionHookers` filter (§9.3).                                                                                                                                                                                           |
| T389 P4W3, Harnu mod outside Harnu (`external-install-core.ts`)          | Shipped.                                                                                                                                                                                                    | **Builds on.** The same `CLAUDE_CODE_PLUGIN_DIRS` switch for the scrubber's row (§8.3).                                                                                                                                                                                                                   |
| T389 P1W6, telemetry (the Harnu mod's sensor channel)                    | Shipped.                                                                                                                                                                                                    | **Extends, W3.** The Harnu mod reads `secret-scrubber.counts` (a foreign `$.state` read) and relays it on its existing channel. That adds one `stateKeys` entry to its `api-surface.json` under MOD-3.                                                                                                    |
| T389 P4W5, compaction digest and durable context                         | Planned.                                                                                                                                                                                                    | **Overlaps, no duplication.** A digest written from scrubbed rows is clean. Its memory writes should strip tags (§7.2).                                                                                                                                                                                   |
| T389 waves on secrets, redaction or `session.append` hooks               | **None.** The Harnu mod hooks no `session.append` and no `tool.call` today. Its only `session.append` use is as a call (`01-contract.md:760`). SEC-8 (`00-master.md:501`) bars secrets in its own payloads. | Nothing to duplicate.                                                                                                                                                                                                                                                                                     |
| T447, the `$.harnu` noun (`docs/specs/T447-harnu-sdk-noun/`, ADR-0019)   | Merged as a spec (`9142876`, PR #41); status "specified (not implemented)" (`00-spec.md:3`). No `resources/harnu-sdk/` exists.                                                                              | **Independent.** The scrubber does not depend on the noun. If T447 ships, a third-party mod could read the counts through it; that would be a T447 delta, not this spec's.                                                                                                                                |
| `lintSecrets`, Harnu's card and memory check (`memory-core.ts:347-371`)  | Shipped. §11.                                                                                                                                                                                               | **Complements.** Different place, different job. See §11.                                                                                                                                                                                                                                                 |
| `redactTranscript`, MCP disclosure redaction (`transcript-redact.ts:72`) | Shipped. "best-effort, not a security boundary" (`:13-17`); marker `<redacted>` (`:46`).                                                                                                                    | **Complements.** It redacts what Harnu _discloses_ (a `get_session` preview, `tool-handlers.ts:567-570`). The scrubber redacts what is _stored_. Once both ship, the preview reads placeholders, and `redactTranscript` is the backstop the privacy lesson asks for (`docs/lessons/privacy/001-…:22-24`). |

## 11. Harnu's existing secret check, and how this relates

`lintSecrets` (`src/main/mcp/memory-core.ts:366-371`) refuses text matching any of 8 patterns
(`:347-359`) and names the kind, never the value. It guards:

- `memory_append` (`validate.ts:381-382`) and `update_card.appendBody` (`tool-handlers.ts:1487-1498`);
- `update_card.replaceBody` and the board's body edits (`roadmap-ipc.ts:1452`, `:1491`);
- the dispatch boot prompt and the generate prompt (`roadmap-ipc.ts:1190`, `:1347`);
- `submit_manifest`, card by card (`roadmap-ipc.ts:1649`, `server.ts:326-327`).

**`create_card` is not linted.** Its body goes straight to `createCardFile`
(`tool-handlers.ts:1395-1410`). So the card's own premise ("Harnu already refuses card writes that
contain a secret") holds for `update_card` and the manifest, not for `create_card`. This is recorded
as SCR-Q7; this spec does not change it.

How the two relate:

1. **Different layer.** `lintSecrets` refuses a write _into Harnu's files_ (memory, cards, boot
   prompts). The scrubber rewrites what _the session_ keeps. Neither replaces the other.
2. **The scrubber removes a failure mode.** The automatic session digest writes through
   `appendMemoryEntry` (`memory-digest.ts:316`, `:393`), so a recap that quotes a secret fails with
   `BAD_ENTRY` today. With the scrubber, the recap quotes a placeholder and the write succeeds.
3. **Placeholders pass the lint.** The lint's patterns hit **0** over 108 placeholder samples: 18 rule
   ids × 6 shapes (bare, `API_SECRET=`, `password:`, JSON `client_secret`, a URL's password, a bearer
   header). See 02 §3.3. So no Harnu write path will refuse a placeholder.
4. **One rule list, later.** The two lists differ. `lintSecrets` has 8 patterns, and its `openai-key`
   rule misses `sk-proj-…` and `sk-ant-…` keys, which have inner dashes. The scrubber's 18 rules are a
   superset. Sharing one module is SCR-Q4; this spec does not merge them.

## 12. Implementation outline (C-6)

Waves in dependency order. **S** is about a day, **M** a few, **L** a week or more.

| Wave | Size | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Depends on |
| ---- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| W0   | M    | **Spike.** Check every §13 assumption on the then-current CLI: tier order, #92533 interactive and in a tick, the mid-turn and argv queue records, the `@`-mention attachment, the L1 race, and `/scrub off` through `prompt.submit`. Measure the `high-entropy` rule on real tool output, counting hits per rule and never printing values; the result decides its default. Pin `minCli`.                                                                                                                                   | —          |
| W1   | M    | **The mod.** `resources/scrubber/`: the prototype hardened (rules, allowlist, vault, resolution policy, breaker, off switches, `/scrub`). Its tests run in `scripts/ci/mod-step.mjs` the way the Harnu mod's do, plus a property test that `detect()` never throws on random input. It ships an `api-surface.json` with a static test that the surface stays closed. Add `SHA` to the identifier gate's `ALLOWED_UPPER_PREFIXES` (`tests/no-client-identifiers.test.ts:62`), since the hash's dashed name trips it (04 §2). | W0         |
| W2   | M    | **Staging.** A second staged dir (`<userData>/scrubber/<stageKey>/secret-scrubber/`), inserted right after the Harnu mod's `--plugin-dir` for interactive, agent-dispatched and tick sessions. The global setting (stage or not, plus the `scrubber-off` flag file for running sessions) and the per-folder setting.                                                                                                                                                                                                        | W1         |
| W3   | M    | **Disclosure and audit in Harnu.** The Harnu mod relays `secret-scrubber.counts` (its `api-surface.json` gains the foreign read). The session row shows the count, and a folder gets one Activity notice. A tripped breaker raises an operator notice. Add the `transcript` chip, the `harnu-scrubber` row source and the `pickPermissionHookers` filter, and the "degraded" chip. Memory writes strip placeholder tags.                                                                                                    | W2         |
| W4   | M    | **L1.** Main rewrites the `tool-results/*.txt` files of sessions it started, once the row that names them lands, with the same rule set compiled for Node. Only if W0 measures the race as safe; otherwise drop it and keep L1 documented.                                                                                                                                                                                                                                                                                  | W1         |
| W5   | S    | **Outside Harnu.** The "Also outside Harnu" switch on the Mods row, and the mod's own marketplace file for `/plugin install`.                                                                                                                                                                                                                                                                                                                                                                                               | W1         |
| W6   | S    | **Optional.** The `telemetry.log { to: 'collector' }` scrub (L6).                                                                                                                                                                                                                                                                                                                                                                                                                                                           | W1         |

Repo contracts each wave owes:

| Contract                               | W1  | W2                                                                               | W3                         | W4  | W5           | W6  |
| -------------------------------------- | --- | -------------------------------------------------------------------------------- | -------------------------- | --- | ------------ | --- |
| `CHANGELOG.md` entry                   | —   | yes                                                                              | yes                        | yes | yes          | yes |
| `docs/user/` (the CLAUDE.md contract)  | —   | yes (new page `docs/user/secret-scrubber.md`, and `mods.md`)                     | yes                        | yes | yes          | —   |
| `docs/harnu-features.md` + marker bump | —   | yes (agents learn placeholders, the resolution policy, `/scrub keep-next`/`off`) | yes (the count)            | —   | —            | —   |
| `design.md` + `en.json` + `pt-BR.json` | —   | yes (the two switches)                                                           | yes (count, chip, notices) | —   | yes (switch) | —   |

**The user-docs CI gate will not fire for most of this.** Its trigger is an **added top-level** file
under `src/main/` or `src/renderer/src/components/`, or a change to `tool-catalog.ts`. Nested dirs are
exempt on purpose (`scripts/ci/user-docs-gate-core.mjs:9-19`, `isTopLevelUnder` `:35-41`). A
`src/main/scrubber/…` module is nested. The `docs/user/` row above is owed by the CLAUDE.md contract
("a person using the app gains a new thing to see or do"), not by the gate. Reviewers must check it by
hand, or W2 must add a top-level `src/main/scrubber-settings.ts` that the gate sees.

W1 alone changes nothing a user sees, because nothing stages the mod yet. So it owes no CHANGELOG
entry. Its `resources/scrubber/` source is covered by the CI mod step.

## 13. Assumptions the W0 spike must check

| Id   | Assumption                                                                                                                                                                                                                                                              | Why it matters                                 |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| A-1  | Inside one tier, an earlier `--plugin-dir` sits outside a later one, so its `session.append` hook runs first. Not documented; not run.                                                                                                                                  | L5: staged second ⇒ outside every user plugin. |
| A-2  | #92533 stays closed on the shipping CLI. Verified on 2.1.296 headless, with the hook proven to fire (04 §1.6). **Unrun:** interactive; a Scheduler tick; an isolated agent's Bash input rewritten after "Allow once".                                                   | §8.2, §8.3: the Bash hook.                     |
| A-3  | `$.ui.ask` inside a `tool.call` hook works interactively. The tests answer `AskUserQuestion` themselves; no interactive run resolved a placeholder.                                                                                                                     | §6.2.                                          |
| A-4  | A prompt typed mid-turn writes a `queue-operation` entry, and `prompt.submit`'s rewrite reaches it (`ref:143` says so). Not reproduced: the turn ended first. Also unknown: whether an interactive session's argv starting prompt is enqueued raw, as a `-p` prompt is. | L2's interactive half; dispatched sessions.    |
| A-5  | An `@`-mentioned file's attachment payload is stored as made (`ref:143`) and so holds the raw file. Run A2 had no attachment with file content.                                                                                                                         | L8.                                            |
| A-6  | Main can rewrite a `tool-results/*.txt` file without racing a `Read` of it by the session.                                                                                                                                                                              | W4.                                            |
| A-7  | The tool record that `tool.call` returns is recorded whole. The runs saw a scrubbed `toolUseResult` for Bash; `Read`, `Grep`, `WebFetch` and MCP results were not run live.                                                                                             | §5.2 for non-Bash tools.                       |
| A-8  | The status line text carries no value. True by construction (`record()` writes a number), noted for review.                                                                                                                                                             | §7.                                            |
| A-9  | A typed `/scrub off` reaches `command.run` without going through the scrubber's `prompt.submit` drop. Tested through `$.command.run` only.                                                                                                                              | §9.2, point 3.                                 |
| A-10 | `$.plugin.root` of a staged mod is `<userData>/scrubber/<stageKey>/secret-scrubber`, so `../../scrubber-off` is one file Harnu owns. The engine normalizes the path (04 §2); the staged layout is W2's to fix.                                                          | §9.1 live off switch.                          |
| A-11 | `git ls-files --error-unmatch` and `git check-ignore -q`, run in the session's cwd, classify a path correctly from a subdirectory, a worktree and a path outside the repo. Outside a repo both exit non-zero, so the path is "other" and the person is asked.           | §6.2.                                          |

## 14. Open questions (C-7)

| Id      | Question                                                                                                                                                                                                                                                        | Who decides                    |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| SCR-Q1  | Default on, or opt-in, for agent-dispatched sessions and ticks? This spec says on everywhere (§9.1). The breaker and the flag file bound the damage of a bug, but a false positive in an unattended run has no person to notice it.                             | Operator                       |
| SCR-Q2  | When W0 has measured real tool output: what false-positive rate makes the `high-entropy` rule default on? This spec proposes under one per MB.                                                                                                                  | Operator, on W0's numbers      |
| SCR-Q3  | Should silent resolution into a gitignored file also require that the value came from **that same file**? That would make "edit my `.env`" silent and every other copy a question (§6.2, the trade).                                                            | Operator, with security review |
| SCR-Q4  | Share one rule module between the scrubber and `lintSecrets` (and `redactTranscript`)? One list in Node and in the mod means a build step, or a copied table with a parity test.                                                                                | Implementer (W1)               |
| SCR-Q5  | Images: drop image blocks in sessions that opt in to a strict mode, or accept L3?                                                                                                                                                                               | Operator                       |
| SCR-Q6  | Offer a one-time "scrub my existing transcripts" pass from Harnu over `~/.claude/projects/`? It rewrites the operator's history files and cannot be undone.                                                                                                     | Operator                       |
| SCR-Q7  | Add `lintSecrets` to `create_card` (§11)? Out of this card's scope, and a one-line fix.                                                                                                                                                                         | Operator (a separate card)     |
| SCR-Q8  | Placeholder format. `[REDACTED:<rule>#<tag>]` is ASCII, greppable and passes `lintSecrets`. Keep it, or align it with `redactTranscript`'s `<redacted>`?                                                                                                        | Implementer (W1)               |
| SCR-Q9  | Ask Anthropic for `prompt.submit` to run before the `-p` enqueue (L2), and for a hook on the persisted-output write (L1)?                                                                                                                                       | Operator                       |
| SCR-Q10 | Strip placeholder tags from what Harnu writes to project memory (§7.2)? Stripping loses "same secret as before" across digests, and keeping it leaks that correlation if memory is committed.                                                                   | Operator                       |
| SCR-Q11 | The breaker trips at 3 consecutive failures and stays fail-closed (§9.2). Should a trip in an **unattended** session (nobody to type `/scrub off`) also turn the scrubber off for that session after the operator is notified, or wait for the operator's flag? | Operator                       |

## 15. Repo contracts for this change (C-8)

This change adds only files under `docs/specs/T450-secret-scrubber/`. It is docs-only, so it owes no
CHANGELOG, `docs/harnu-features.md` or `docs/user/` change. English only. No client identifiers: the
repo paths named are this repo's own, and the measurement corpus is this repo. Checks run on the final
tree (`npx prettier --check`, `npx vitest run tests/no-client-identifiers.test.ts`) are in the report.

## 16. Round-1 findings and where each is answered

| Finding                                             | Answer                                                                                                                                                   |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. U-2: errored results stored raw                  | §5.2 (the deny, proven live: run E), §5.3 L0, §9.2; test `an errored result …`.                                                                          |
| 2. Silent Edit/Write resolution bypasses consent    | §6.2 (tracked → never, ignored or listed → silent, other → ask, nobody → refuse; the trade stated), SCR-Q3; five `resolution` tests.                     |
| 3. The vault is lost on hibernation and reload      | §6.4 (refuse unknown placeholders; recovery by re-read), proven live on a resumed session (04 §1.5); test `a placeholder this session cannot resolve …`. |
| 4. The blast radius of fail-closed                  | §9.2 (stated plainly; safety vs bookkeeping; breaker; live off switches; "do not run it again"), §9.1, SCR-Q11; four `failure` tests.                    |
| 5. The round trip for contextual rules              | §4, §6.2 (vault literal match); test `a value seen once is caught by its literal …`.                                                                     |
| 6. MOD-9: the companion is the first `--plugin-dir` | §8.3 (second, right after the Harnu mod; no amendment needed), §5.3 L5.                                                                                  |
| 7. "Dormant without a spawn token"                  | §8.2 (corrected; MOD-2, MOD-3, SEC-9(d) cited).                                                                                                          |
| 8. False positives on real tool output              | 01 §3 (SSH public key, `go.sum`, CSP nonce, public PEM filters); `high-entropy` off by default until W0 (§4, §9.1, SCR-Q2).                              |
| 9. #92533 evidence                                  | §8.2, 04 §1.6 (marker run on 2.1.296; B4b withdrawn; smoke B4 history; unrun cases in A-2).                                                              |
| Low: telemetry wording                              | §0 item 6, §1, §7.3.                                                                                                                                     |
| Low: the tag lands in memory                        | §7.2, SCR-Q10, W3.                                                                                                                                       |
| Low: the docs/user gate row                         | §12 (nested dirs are exempt; the contract still applies).                                                                                                |
| Low: `pickPermissionHookers`                        | §9.3.                                                                                                                                                    |
| Low: the hot-reload citation                        | §3, §6.4 (`ref:72` and SKILL.md, each for what it says).                                                                                                 |
| Low: 03 §1.1's "two exceptions"                     | 04 §1.1 reworded.                                                                                                                                        |
