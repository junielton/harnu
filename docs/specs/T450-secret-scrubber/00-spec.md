# T450 — Secret scrubber: secrets never reach the model or the transcript

**Status:** specified (not implemented) · **Date:** 2026-10-09 · **Card:** T450 · **ADR:**
[`ADR-draft.md`](ADR-draft.md) (proposed; numbered when merged)

Files: this spec, [`01-detection.md`](01-detection.md) (the rules, the false-positive strategy, the
allowlist and the measurements, U-1), [`02-prototype.md`](02-prototype.md) (the prototype mod's
source and its `claude plugin validate` / `claude plugin test` / `tsc` output) and
[`03-live-runs.md`](03-live-runs.md) (the live runs and the build log).

## 0. Summary

A mod that redacts secrets in every row the conversation keeps, before the model reads the row and
before the transcript file stores it. A tool result, a Bash output, a pasted prompt, a subagent's row:
each goes through `session.append`, and the mod hands the engine the row with each secret replaced by
a stable placeholder such as `[REDACTED:github-token#fc55a4b6]`. Harnu's session digests, previews and
project memory read the transcript, so they inherit a clean one.

What this spec decides:

1. **Three hooks, not one.** `session.append` alone leaves the secret on disk in the tool's structured
   record (`toolUseResult`) and in the prompt's queue record. A `tool.call` hook that answers with a
   scrubbed result closes the first, as live runs showed. A `prompt.submit` rewrite narrows the second;
   the `-p` case stays open (§5).
2. **Some leaks stay open, and the spec names them.** A large tool output persisted to
   `tool-results/` is written before any hook sees it. The queue record of a `-p` prompt holds the
   prompt as typed. Images and PDFs are not read. The screen may show a row before its rewrite (§5.3).
3. **Placeholders resolve back, with consent.** The model sees the placeholder, never the value. When
   it writes the placeholder into `Edit`/`Write`, the mod puts the real value back, so a file is never
   corrupted. In `Bash` it puts the value back only after the person says yes (§6).
4. **Fail-closed.** A row the mod cannot check is stored with its text withheld, a prompt is dropped,
   and a tool result is withheld. The secret never passes on a failure (§9.2).
5. **Packaging: a new standalone mod that Harnu bundles and stages,** not code inside the Harnu mod
   (`resources/companion/`). The Harnu mod's static tests forbid a Bash `tool.call`, and it fails open
   by rule. The scrubber needs a Bash hook and fails closed (§8, [`ADR-draft.md`](ADR-draft.md)).
6. **Disclosure is a count, never a value.** The mod's status line reads `3 redacted`, `/scrub` lists
   counts by rule, and Harnu reads the same count from `$.state`. Mods cannot write telemetry with free
   text, so none is written (§7).
7. **Default on** in sessions Harnu starts, with a per-folder off switch and a committed per-repo
   allowlist (§9.1, [`01-detection.md`](01-detection.md) §4).

## 1. Origin and scope

Ideas 2 ("Secret-leak redactor") and 70 ("Secret scrubber on the transcript door") of the operator's
ideation report (`.harnu/out/claude-code-mods-ideas.md` in the main checkout, outside the repo). Both
describe the same mod. Idea 104 (the streamer overlay's redaction layer) is the same cluster and is out
of scope.

Two corrections to the ideas, from this build's types:

- Idea 2 says `$.ui.notice "2 secrets redacted"`. `$.ui.notice` is "one line under the dialog open for
  `tool_use_id`", refused when no call is open (`d.ts:2334-2346`). The status line is `$.ui.status`
  (`d.ts:2466-2477`).
- Idea 70 says `telemetry.log count-only`. A plugin's first-party row is queued only "for built-ins and
  the engine alone", and a collector record reaches the collector "only when the engine raised it"
  (`d.ts:3129-3135`). A third-party mod has no telemetry to write (§7.3).

**In scope:** the detection rules, the hooks and what each one closes, the leaks that stay open, the
opt-out and resolution design, disclosure, packaging, control, failure, the Harnu-side work, and a
prototype that runs.

**Out of scope:** code under `src/`, `resources/` and `tests/`. Also out: changes to the Harnu mod's
waves, OCR of images, and redaction of the operator's existing transcripts at rest (§14, SCR-Q6).

## 2. Conventions

- `ref:N` is line N of `reference.md`, and `d.ts:N` is line N of `types/claude-code.d.ts`. The
  `plugin-authoring` skill wrote both for **Claude Code 2.1.295** on this machine. That file's first
  line reads `// Written by Claude Code 2.1.295.`
- Repo paths are at `cb7fb58`, the base of this branch.
- **Runs.** `claude plugin validate`, `claude plugin test` and the final live run used **2.1.296**,
  because the CLI updated itself mid-session (`claude --version` → `2.1.296 (Claude Code)`). Runs B
  and B4 used 2.1.295. Each run in [`03-live-runs.md`](03-live-runs.md) names its version.
- **Secret-shaped samples.** No committed file holds a value a secret scanner would flag. The prototype
  test builds every sample at run time from harmless parts (`'gh' + 'p_' + …`). The spec writes a
  format as broken-up parts: `gh`·`p_` + 36 alphanumerics.
- **Verified** means read in the code or types at the cited line, or shown by a run whose output is
  pasted. **Assumption** marks everything else, and §13 lists each one for the implementation's spike.

## 3. Grounded in the engine (C-1)

Every mechanism the design relies on, where it is declared, and the run that shows it works.

| Mechanism                                           | Declared at                                                                                               | Shown by                                                       |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `session.append` is every row's append              | `ref:137`; event doc `d.ts:4348-4359`                                                                     | live run A2 (03 §1.1)                                          |
| Rewrite `content` with `next({ ...e, message })`    | `ref:141`; `SessionAppendMessage.content` `d.ts:10630-10637`                                              | tests `session.append > …`; live run A2                        |
| `door`, `origin`, `uuid`, `agentId` are pinned      | `ref:139`; `d.ts:10572-10593`                                                                             | prototype passes them through unchanged                        |
| A row the engine appends is never refused           | `ref:141` ("a row the engine appends is never refused"); `SessionAppendResult` `d.ts:10665-10690`         | fail-closed test (02 §3)                                       |
| `.catch` answers in a failed hook's place           | `Registration.catch` `d.ts:9314-9340`; `ref:79`; the `session.append` example `ref:147-150`               | test `failure > …`                                             |
| Hook budget 10 s, `.catch` grace 1 s                | `HookBudget` `d.ts:5100-5117`                                                                             | 1 MB scanned in 9 ms (01 §5)                                   |
| What is "stored as made"                            | `ref:143`; `SessionAppendInput` doc `d.ts:10558-10565`                                                    | live run B: `toolUseResult` raw (03 §1.2)                      |
| `tool.call` answer is recorded as the result        | `ToolCallResult.result` `d.ts:12718-12726`; deny withholds `d.ts:12702-12709`                             | live runs A and A2: `toolUseResult` scrubbed                   |
| `prompt.submit` rewrites the prompt                 | `d.ts:4092-4103`; "pastes already expanded" `d.ts:9052-9054`                                              | test `when the person means it > …`; interactive run (03 §1.3) |
| Status line                                         | `$.ui.status` `d.ts:2466-2477`                                                                            | interactive run: `⚠ secret-scrubber: 2 redacted`               |
| Ask the person                                      | `$.ui.ask` `d.ts:2415-2430` (rejects in `-p`)                                                             | test `tool.call > a placeholder resolves …`                    |
| Per-session state any plugin reads                  | `$.state` `d.ts:3376-3417` ("Any plugin reads any value", `:3381`)                                        | test `counts … another plugin reads them` (an inline plugin)   |
| Per-plugin store across sessions                    | `$.store` `d.ts:3351-3375`                                                                                | salt persisted: the same placeholder in runs A and A2          |
| Read the repo's config file                         | `$.fs.read` `d.ts:3223-3241` (4 MiB cap)                                                                  | test `repo config > …`                                         |
| Slash command                                       | `$.command.register` `d.ts:3091`, `CommandRunInput` `d.ts:1792-1819`, `CommandRunResult` `d.ts:1837-1872` | test `when the person means it > …`                            |
| `userConfig` options                                | `PluginOptions` `d.ts:7646-7658`; `pluginConfigs` `ref:74`                                                | `claude plugin validate` accepts the manifest (02 §2)          |
| SHA256 in the module                                | global `crypto.subtle.digest` `d.ts:14860-14869` (no HMAC: `digest` only)                                 | every placeholder test                                         |
| Tiers and where a plugin sits                       | `TIERS` `d.ts:12592-12610`                                                                                | not run: §13 A-1                                               |
| Test kit: `mock.session`, inline plugins, `options` | `d.ts:15469-15480`, `15549-15564`, `15939-15954`; `ref:81`                                                | 48 tests (02 §3)                                               |
| Plugin dirs for staging                             | `--plugin-dir`, `CLAUDE_CODE_PLUGIN_DIRS` `ref:72`                                                        | every live run used `--plugin-dir`                             |

Two gotchas the C-5 brief named, and how the prototype avoids them:

- `$` is always written `$.noun.event(...)`. Even an inline test plugin must name its `$.state` key as
  a literal. `claude plugin test` refused `$.state.get(counts)` from an inline plugin with "takes a
  reference whose plugin and key are string literals" (03 §2).
- Every `$` call the plugin makes has a stub. The kit's `session.start` bottom needs `{ cwd }`: the
  first run failed with "next() passed an argument with no { cwd }" until the test's `on('session.start')`
  answered it (03 §2).

## 4. Detection (U-1)

[`01-detection.md`](01-detection.md) holds the full set. In brief:

- **Eighteen rules.** Twelve are provider formats: AWS, GitHub classic and fine-grained, GitLab,
  Slack token and webhook, Stripe, Anthropic, OpenAI, Google, npm and SendGrid. Three are structural:
  the PEM private-key block, JWT, and `scheme://user:PASSWORD@host`. Two are contextual: an
  `Authorization:` header, and a `NAME=value` / `"name": "value"` whose name ends in a secret word.
  The last is statistical: a high-entropy rule for unlabelled tokens.
- **False positives are filtered by shape before entropy is measured.** The filters drop hex digests
  and git SHAs, UUIDs, lockfile `sha512-` integrity values, `data:…;base64,` assets, publishable
  `pk_` keys, identifiers, paths, words and kebab slugs. A tool record's `base64` media bytes are
  never scanned.
- **Allowlist.** A committed `.claude/secret-scrubber.json` lists SHA256 digests of values the repo
  declares harmless, never the values themselves. It can also turn off whole rules.
- **Threshold, measured on this machine.** At 4.0 bits per character, the high-entropy rule hits 4
  times in this repo's 26.4 MB of tracked text, and all 4 are false positives: an opaque session id,
  a base64 PNG literal in two tests, and a long JavaScript symbol. It catches 99.6% of random
  32-character base62 and base64url tokens, but only about 76% of standard base64 ones (01 §5).
- **The test matrix** is 19 positives (every rule, plus a second assignment shape) and 18 negatives, run by `claude plugin test`. The real output
  is pasted in [`02-prototype.md`](02-prototype.md) §3.

## 5. Doors and leaks, honestly (U-2)

### 5.1 Every door the mod rewrites

`session.append` is raised once per row "as the row's originator" (`ref:137`), and `door` names the
route (`d.ts:10556`). The mod hooks the event with no matcher, so every door below goes through it.
It rewrites text blocks and each `tool_result`'s `content` (`ref:141`, `d.ts:10633-10636`).

| Door           | What arrives there (`ref:137`, `d.ts:10556`)                          | The mod                                                                                                                     |
| -------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `prompt`       | the person's prompt, pastes already expanded (`d.ts:9052-9054`)       | scrubbed here and, earlier, at `prompt.submit` (§5.2)                                                                       |
| `command`      | a slash command's record and output                                   | text blocks scrubbed                                                                                                        |
| `response`     | each block of the model's response                                    | text blocks scrubbed; thinking and `tool_use` are pinned (§5.3, L7)                                                         |
| `tool-result`  | a tool's result                                                       | `tool_result.content` scrubbed (string, or nested text blocks)                                                              |
| `tool-message` | rows a tool hands over beside its result                              | text blocks scrubbed                                                                                                        |
| `delivery`     | a prompt or notification folded into a running turn, a peer's message | text blocks scrubbed                                                                                                        |
| `attachment`   | reminders and listings the engine injects                             | text blocks scrubbed; "a rewrite of an attachment rendered per request or carrying media keeps the row as made" (`ref:141`) |
| `hook-context` | a settings hook's or a chain's context                                | text blocks scrubbed                                                                                                        |
| `note`         | a plugin's own `$.session.append`                                     | scrubbed, except the scrubber's own rows                                                                                    |
| `compaction`   | a compaction's boundary and summary                                   | scrubbed; a summary written from scrubbed rows holds only placeholders                                                      |
| `notice`       | the notices the transcript shows                                      | text blocks scrubbed                                                                                                        |

The same holds in every subagent's conversation, because `agentId` names the loop (`ref:137`,
`d.ts:10587-10593`). The subagent's own transcript file shows it: run B4b (03 §1.4).

### 5.2 The two other hooks, and what each closes

**`tool.call`, after `next`: the tool's structured record.** `ref:143` says "a tool result's
structured record beside its tool_result (`toolUseResult`, what the screen draws) … [is] stored as
made". The mod answers the call with `{ result: scrubbed, context }`. Core then "records it in the
transcript as the tool's result" (`d.ts:12722-12725`). A deep scrub of every string in the result,
skipping `base64` media bytes, therefore reaches `toolUseResult`. Two live runs, same prompt, same
fixture file:

| Run                                     | `message.content` of the tool row | `toolUseResult.stdout`                 |
| --------------------------------------- | --------------------------------- | -------------------------------------- |
| B: `session.append` hook only (2.1.295) | placeholders                      | **raw** (`api_secret`, `github` found) |
| A2: all three hooks (2.1.296)           | placeholders                      | placeholders                           |

**`prompt.submit`: the prompt before it is queued.** `ref:143` says the queue's own record of a prompt
"is no row of the conversation: a plugin that must change a prompt's words everywhere rewrites them at
`prompt.submit`, before they are queued". The rewrite also changes what the screen shows ("the user
message on screen follows", `d.ts:4096`). The interactive run showed the placeholder in the person's
own row (03 §1.3). It did not close the `-p` case, though (L2 below).

### 5.3 Where a secret still lands, and what would close it

Each line is a leak this design does **not** close, with its evidence and its fix.

| #   | Where the secret lands                                                                                                                                                                                                                                       | Evidence                                                                                                                                                                                                                                                                    | What would close it                                                                                                                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| L1  | **A large tool output, persisted whole.** Bash output past the inline cap is written to `<transcript dir>/<session>/tool-results/<id>.txt`. The row carries a 2 KB preview and the path (`persistedOutputPath`, `d.ts:20394`; `rawOutputPath` `d.ts:20366`). | Runs A and A2: a 233 KB `big.log` with the secret at its end. The `tool-results/*.txt` file holds the raw `API_SECRET`. The row and `toolUseResult` hold none.                                                                                                              | An engine change, since the file is written before `tool.call` returns. Until then, Harnu's main process can rewrite the file in place once the row lands (W4, a race the spike must measure). The model never reads it unless it `Read`s the path, and that read is scrubbed.                                                                                                       |
| L2  | **The `-p` prompt's queue record.** A headless prompt's `queue-operation` `enqueue` entry holds the prompt as typed, even with the `prompt.submit` rewrite.                                                                                                  | Runs A, A2 and B: entry 0 (`queue-operation`/`enqueue`) holds the raw key. An interactive prompt typed while idle wrote no `queue-operation` entry at all (interactive run). A prompt typed mid-turn was **not** reproduced: the turn ended before it was queued (§13 A-4). | A session Harnu dispatches gets its starting prompt as a `claude` argv positional (`docs/harnu-features.md`), which may take the same enqueue path (not run, §13 A-4). Harnu lints every boot prompt it builds from a card (`buildDispatchPrompt`, §11), so such a prompt holds no secret the lint knows. The general fix is the engine's: raise `prompt.submit` before the enqueue. |
| L3  | **Image and document blocks.** A screenshot of a key, or a PDF that holds one. An image or document block "may be dropped or moved, not changed or added" (`ref:141`, `d.ts:10633-10635`), and an attachment carrying media "keeps the row as made".         | Types only.                                                                                                                                                                                                                                                                 | Dropping the block loses the image. OCR is out of scope (SCR-Q5).                                                                                                                                                                                                                                                                                                                    |
| L4  | **The screen before the rewrite.** "The screen, an SDK stream or Remote Control may show the row just before its rewrite; the model and the transcript file never read that form" (`d.ts:4352-4355`).                                                        | Types only.                                                                                                                                                                                                                                                                 | Nothing in a mod. It is not stored and not sent to the model; a screen share or recording would see it.                                                                                                                                                                                                                                                                              |
| L5  | **Plugins above the scrubber.** A plugin whose `session.append` hook runs before the scrubber's sees the raw row. Same-tier mods are not isolated from each other (ADR-0018 `:42-44`).                                                                       | Tier order: `d.ts:12592-12610`. Order inside the `user` tier is not documented (§13 A-1).                                                                                                                                                                                   | An organization seats the scrubber at the `prepend` tier (managed settings). Harnu stages it first among its `--plugin-dir` flags (W2), if A-1 holds.                                                                                                                                                                                                                                |
| L6  | **Collector telemetry.** The engine's own OpenTelemetry records, when the operator configured a collector that logs prompts or tool details.                                                                                                                 | `telemetry.log` with `to: 'collector'` is hookable and its content is rewritable (`d.ts:4278-4289`, `d.ts:12375-12386`). First-party rows carry no free text (`TelemetryChoice`, `d.ts:12354-12363`).                                                                       | A `telemetry.log { to: 'collector' }` hook that scrubs string attributes (W5, optional). The prototype does not hook it.                                                                                                                                                                                                                                                             |
| L7  | **Thinking blocks and `tool_use` input.** The bottom puts these back "whole and in place" (`ref:141`).                                                                                                                                                       | Types only.                                                                                                                                                                                                                                                                 | Narrow by design. The model only ever saw placeholders, so it can only write a raw value it inferred. With `/scrub keep-next` it saw the raw value on purpose (§6.3).                                                                                                                                                                                                                |
| L8  | **What the engine stores on its own** as made: "the row's timestamps and parent links, and an attachment's payload" (`ref:143`), and the engine's later edits of a kept row (`ref:141`).                                                                     | Types only. Run A2's audit found no raw value in any `attachment` entry (03 §1.1).                                                                                                                                                                                          | None needed today: the audit found none. The spike re-audits with an `@`-mentioned `.env` file (an attachment payload, §13 A-5).                                                                                                                                                                                                                                                     |
| L9  | **Before the mod loads, and outside it.** A session started without the mod (`claude` outside Harnu, the mod off), a `--resume` of an old transcript ("loads are not appends", `ref:137`), and every transcript written before the mod existed.              | By construction.                                                                                                                                                                                                                                                            | §8.3 (outside Harnu). Old transcripts: SCR-Q6.                                                                                                                                                                                                                                                                                                                                       |

Harnu's readers inherit what is clean. `claude-reader.ts` reads `firstPrompt` from user rows
(`:895-905`), and `transcript-truth.ts` reads titles from `last-prompt` (`:218-240`). Run A2's
`last-prompt` entries all hold the placeholder. No reader in `src/` reads `toolUseResult` or
`queue-operation`: a grep for both returns no hits. So L2's raw prompt reaches no Harnu surface today.

## 6. When the person means it (U-3)

### 6.1 What the model sees

The model sees `[REDACTED:<rule>#<tag>]`. The tag is the first 8 hex characters of
SHA256(salt + value). The salt is a random UUID the mod keeps in `$.store`, one per install (02 §2).
This gives the model three things to reason about:

- **Kind.** The rule says what the value was: `stripe-secret-key`, `secret-assignment`. In the
  interactive run the model answered "it's a live Stripe secret" from the rule name alone (03 §1.3).
- **Identity.** The same value gives the same placeholder, in every row and every session on this
  machine (test `the same value gets the same placeholder`; runs A and A2 both read `#f2028cfc`). The
  model can tell that two rows hold the same secret, and that a rotated key is a different one.
- **No value.** A digest of a high-entropy key reveals nothing practical. The salt keeps a
  low-entropy password in a connection string from being matched against a dictionary of known
  digests. `crypto.subtle` offers `digest` only, not HMAC (`d.ts:14860-14869`), so the tag is a salted
  digest, not a keyed MAC. The tag is not portable across machines by design. The repo allowlist uses
  plain SHA256 instead (§4).

### 6.2 The model needs the real value: resolution

The mod keeps the session's placeholder → value table in a **module variable**, the vault. It is never
in `$.state`, which every plugin reads (`d.ts:3381`), and never in `$.store`, which is written to disk.
A hot reload empties it (`ref:72`). A placeholder minted before the reload then stays a placeholder:
the command fails visibly, and nothing leaks.

| The model writes a placeholder into … | What the mod does                                                                                                                                                                                                                   | Why                                                                                                                                                                                                                                                             |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Edit`, `Write`, `NotebookEdit`       | Puts the real value back in every string of the input, **without asking** (test `Edit gets the real value back`).                                                                                                                   | Without this, editing a `.env` file the model has read would write the placeholder's text into the file in place of the secret, or fail to match `old_string`. These tools write only this machine's files.                                                     |
| `Bash`                                | Asks the person: "Let this Bash command use the real value of [REDACTED:…]?" with "Allow once" / "Keep redacted" (`$.ui.ask`). Only "Allow once" resolves (test `a placeholder resolves for Bash only after the person allows it`). | A command can send a value off the machine (`curl … ?k=`). The person decides each time. In `-p`, and in any session with nobody to ask, `$.ui.ask` rejects (`d.ts:2421`). The hook then runs the command with the placeholder unchanged, and it fails visibly. |
| Any other tool (MCP, `WebFetch`, …)   | Nothing. The placeholder stays.                                                                                                                                                                                                     | These reach other machines.                                                                                                                                                                                                                                     |

The `Bash` output that echoes a resolved value back is scrubbed again on its way in, so the round trip
stays clean.

`userConfig.resolve` (`ask` | `never`, default `ask`) turns Bash resolution off. Edit/Write resolution
cannot be turned off, because turning it off corrupts files (SCR-Q3).

### 6.3 The person pastes a key on purpose

The default path needs no escape at all. The model sees the placeholder, and the person's next "deploy
with it" resolves through §6.2. The key never reaches the model or the transcript, and the session can
still use it.

For the rare case where the model must read the literal (a malformed key the person is debugging),
`/scrub keep-next` sends **the next prompt only** through unredacted: both the `prompt.submit` rewrite
and the prompt row's scrub are skipped. The test `/scrub keep-next lets exactly one prompt reach the
model as typed` proves the second prompt is scrubbed again. The command's own output row says it,
so the transcript records that the person chose this.

A per-repo escape lives in `.claude/secret-scrubber.json` ([`01-detection.md`](01-detection.md) §4):
`allow` takes digests of values the repo declares harmless, and `disable` takes rule ids. A broken file
logs one line and keeps every rule on (the prototype's `loadRepoConfig`). Harnu's per-folder off switch
(§9.1) is the coarse escape.

## 7. Disclosure (U-4)

### 7.1 What the person sees

- **Status line.** `$.ui.status("<n> redacted")` after each redaction. The engine prefixes the
  plugin's name, so the interactive run drew `⚠ secret-scrubber: 2 redacted` under the prompt (03
  §1.3). The prototype's first version wrote its own prefix and the line read "secret-scrubber:
  secret-scrubber: 1 redacted"; the prefix was dropped.
- **The placeholder in place.** The person's own prompt row shows the placeholder (`d.ts:4096`), so
  they see exactly what was taken.
- **`/scrub`** prints `<n> redacted this session: <rule> <count>, …`.
- **In Harnu (W3).** The Harnu mod reads `secret-scrubber.counts` from `$.state`. The test `counts … another
plugin reads them` shows a second plugin reading it. Harnu shows it as a count on the session row,
  and on a folder's first redaction posts one Activity notice.

### 7.2 What the counts hold

`{ total, byRule: { <rule>: n } }`. That is rule ids and numbers, never a value and never a tag
(02 §2, `record()`). The test asserts the exact JSON another plugin reads:
`{"total":2,"byRule":{"anthropic-key":1,"private-key":1}}`. The tag is left out on purpose: it is
stable per value, and a stable id in a log becomes a cross-session tracker for the secret.

### 7.3 Telemetry

None. A third-party plugin cannot write a first-party row or a collector record (`d.ts:3129-3135`).
First-party rows hold no free text (`d.ts:12354-12363`). If Harnu ever logs the count (W3), it logs
`{ folderAlias, total, byRule }` only, under the same rule: no value, no tag. The Harnu mod's own
contract already forbids prompt text and secrets in its payloads (`01-contract.md:678` of T389).

## 8. Packaging (C-3)

### 8.1 Decision

A **new standalone mod, `secret-scrubber`, which Harnu bundles under `resources/scrubber/` and stages
as its own `--plugin-dir`** beside the Harnu mod. Harnu's main process owns staging, the setting, the
audit row and the count display. The mod owns all scrubbing. [`ADR-draft.md`](ADR-draft.md) records
the decision.

### 8.2 Why not the alternatives

| Option                                        | Why not                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Inside the Harnu mod (`resources/companion/`) | Its closed surface forbids exactly what the scrubber needs. MOD-3 allows `tool.call` only on `Edit`/`Write`/`NotebookEdit` and Harnu's MCP tools, and "No matcher may match `Bash` (static test, #92533)" (T389 `00-master.md:524`, risk R8 `:605`). MOD-2 makes every hook return `next(e)` on failure, which is fail-open (`:523`); the scrubber must fail closed. It goes dormant without a spawn token (`register.ts:484-491`), and its off/shadow/active modes follow a CLI gate (`companion-prefs-core.ts:105-117`). The scrubber must run the same outside Harnu. |
| Harnu main-process code only                  | Main sees a row only after the engine wrote it. By then the model has read the secret and the file has it. Rewriting the JSONL at rest races the engine's appends. Main keeps one job: L1's persisted files (W4).                                                                                                                                                                                                                                                                                                                                                        |
| Folded into T447's `$.harnu` noun mod         | That mod is a typed SDK over Harnu's verbs, never staged in ticks (T447 `00-spec.md:256-296`). A scrubber has no Harnu verb to call and must load everywhere.                                                                                                                                                                                                                                                                                                                                                                                                            |

**#92533 does not reproduce on 2.1.295.** This was the reason the Harnu mod banned Bash hooks:
"a pass-through Bash `tool.call` hook breaks `Agent(isolation: "worktree")`" (ADR-0018 D6 `:121-126`,
smoke B4). Run B4 repeated the smoke on this build with the prototype loaded. The isolated subagent's
`pwd` was inside `.claude/worktrees/agent-…` and `.git` named the worktree's gitdir. The subagent's
`toolUseResult` was scrubbed, which shows the hook fired on its Bash call (03 §1.4). One headless run
is not proof across versions, so the spike re-runs it (§13 A-2) and keeps the Harnu mod's static test
as it is.

### 8.3 Where it runs

| Session                                                      | Gets the scrubber?                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interactive, started by Harnu                                | Yes, staged first among the `--plugin-dir` flags (W2), the same insertion `insertCompanionPluginDir` does (`staging-core.ts:77-86`).                                                                                                                                                                                                                          |
| Agent-dispatched (`create_session`, board/manifest dispatch) | Yes. These sessions run unattended, so `$.ui.ask` has nobody to answer and Bash resolution stays off in effect (§6.2).                                                                                                                                                                                                                                        |
| Scheduler tick                                               | Yes (W2), after the spike confirms #92533 stays closed. The mod calls no MCP verb, no network and no process. Its only writes are `$.store` (the salt) and `$.state` (counts). It does not widen an `observe` tick's reach the way T447's noun would.                                                                                                         |
| Outside Harnu                                                | Only if installed. Two ways: `/plugin install secret-scrubber --marketplace <owner>/<repo>` (the mod's own marketplace file, `ref:85-97`), or an "Also outside Harnu" switch on its Settings → Mods row. The switch writes `CLAUDE_CODE_PLUGIN_DIRS` the way the Harnu mod's P4W3 does (`external-install-core.ts:13`). Without either, it gets nothing (L9). |
| An organization's managed seat                               | Install at the `prepend` tier to sit above every user plugin (L5).                                                                                                                                                                                                                                                                                            |

## 9. Control and failure (C-4)

### 9.1 On, off, default

- **Default: on** for every session Harnu starts. Changes made by the scrubber are visible (§7), and
  each leak it closes is a real file on disk (§5.2). The measured false-positive rate is low (01 §5).
- **Global switch:** Settings → Mods, the scrubber's row, on/off. Off means Harnu does not stage the
  mod (a session already running keeps it until restart). This mirrors how the Harnu mod's kill
  switch gates staging (`spawn-inject.ts:72-96`).
- **Per folder:** the folder's menu offers "Scrub secrets in new sessions" (on by default). It is
  resolved at spawn, like the folder's other spawn-time settings.
- **Inside a running session:** `/scrub keep-next` (one prompt), plus the `userConfig` fields from the
  config menu (`resolve`, `highEntropy`, `entropyThreshold`; a change reloads the module, `ref:74`).
- **Per repo:** `.claude/secret-scrubber.json` (01 §4).

### 9.2 Failure: fail-closed, through `.catch`

| Hook             | If the hook throws or overruns before `next`                                                                                                                                                                                                                           | If it fails after `next`                                                                                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `session.append` | `.catch` calls `next(withheld(e))`: every text block reads `[secret-scrubber failed: text withheld]` and every result reads `[secret-scrubber failed: result withheld]` (test `failure > …`). The row cannot be refused (`ref:141`), so it is stored, minus its words. | `next(e)` replays the scrubbed call already made (`ref:79`).                                                                                                                   |
| `prompt.submit`  | `{ drop: 'secret-scrubber could not check this prompt' }` (`d.ts:4096-4102`).                                                                                                                                                                                          | Replays.                                                                                                                                                                       |
| `tool.call`      | `next(e)`: the call runs with its placeholders unresolved. That is the safe direction.                                                                                                                                                                                 | `{ deny: 'secret-scrubber could not check this result' }`. The model reads "`<tool>` ran, and a plugin withheld its result" (`d.ts:12706-12709`), and nothing raw is recorded. |

The `.catch` grace is 1 s (`d.ts:5117`), and the handlers do no work beyond building a constant.
`session.start` failing (a store error, say) leaves the salt empty: tags become plain SHA256, and
Harnu shows a "degraded" chip (W3). A broken repo config never fails the hook (§6.3).

`claude plugin validate` reports all three hooks as `gating hook with .catch` (02 §2).

### 9.3 Settings → Mods audit chips

Computed with Harnu's own `parseValidateReport` and `buildAnalysis` from `src/main/mods-audit-core.ts`
over the prototype's `claude plugin validate --json`: **`files`, `prompts`, `tool-calls`**, and no
warnings (02 §4). They come from `fs.read` (`:378`), `prompt.submit` (`:379`) and `tool.call` (`:381`).

Two gaps the implementation closes (W3):

- **No chip for rewriting the transcript.** `session.append` is in no table (`:370-393`). Add a
  `transcript` chip, "Rewrites what the conversation keeps", derived from a `session.append` hook. Its
  label needs `design.md` and both locales.
- **`pickPermissionHookers` lists the scrubber.** It lists any non-Harnu mod with `tool-calls` as a
  "permission hooker" (`:748-764`). That is accurate (the mod rewrites Bash input after a yes), but the
  scrubber is Harnu's own bundled mod. Give it a row source of its own (`'harnu-scrubber'`) next to
  `'harnu'` and `'harnu-skills'` (`:18`), so the audit names it as Harnu's.

## 10. Overlap: what exists, what this adds (C-2)

| Existing thing                                                           | Status, checked against the code                                                                                                                                                                            | Relation                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T389 P1W2, mod skeleton and staging (`staging.ts`, `staging-core.ts`)    | Shipped (commit `7446534`).                                                                                                                                                                                 | **Builds on.** W2 reuses the stage-and-insert pattern for a second mod dir. Nothing new in the Harnu mod.                                                                                                                                                                                                |
| T389 P4W1, Mods audit tab (`mods-audit-core.ts`)                         | Shipped, parts A and B.                                                                                                                                                                                     | **Extends.** A `transcript` chip and a `harnu-scrubber` row source (§9.3).                                                                                                                                                                                                                               |
| T389 P4W3, Harnu mod outside Harnu (`external-install-core.ts`)          | Shipped.                                                                                                                                                                                                    | **Builds on.** The same `CLAUDE_CODE_PLUGIN_DIRS` switch for the scrubber's row (§8.3).                                                                                                                                                                                                                  |
| T389 P1W6, telemetry (the Harnu mod's sensor channel)                    | Shipped.                                                                                                                                                                                                    | **Extends, W3.** The Harnu mod reads `secret-scrubber.counts` (a foreign `$.state` read) and relays it on its existing channel. That adds one `stateKeys` entry to its `api-surface.json` under MOD-3.                                                                                                   |
| T389 P4W5, compaction digest and durable context                         | Planned.                                                                                                                                                                                                    | **Overlaps, no duplication.** A digest written from scrubbed rows is clean. P4W5 needs nothing from this spec.                                                                                                                                                                                           |
| T389 waves on secrets, redaction or `session.append` hooks               | **None.** The Harnu mod hooks no `session.append` and no `tool.call` today. Its only `session.append` use is as a call (`01-contract.md:760`). SEC-8 (`00-master.md:501`) bars secrets in its own payloads. | Nothing to duplicate.                                                                                                                                                                                                                                                                                    |
| T447, the `$.harnu` noun (`docs/specs/T447-harnu-sdk-noun/`, ADR-0019)   | Merged as a spec (`9142876`, PR #41); status "specified (not implemented)" (`00-spec.md:3`). No `resources/harnu-sdk/` exists.                                                                              | **Independent.** The scrubber does not depend on the noun. If T447 ships, a third-party mod could read counts through it; that would be a T447 delta, not this spec's.                                                                                                                                   |
| `lintSecrets`, Harnu's card and memory check (`memory-core.ts:347-371`)  | Shipped. §11.                                                                                                                                                                                               | **Complements.** Different place, different job. See §11.                                                                                                                                                                                                                                                |
| `redactTranscript`, MCP disclosure redaction (`transcript-redact.ts:72`) | Shipped. "best-effort, not a security boundary" (`:13-17`); marker `<redacted>` (`:46`).                                                                                                                    | **Complements.** It redacts what Harnu _discloses_ (a `get_session` preview, `tool-handlers.ts:567-570`). The scrubber redacts what is _stored_. Once both ship, the preview reads placeholders and `redactTranscript` is the backstop the privacy lesson asks for (`docs/lessons/privacy/001-…:22-24`). |

## 11. Harnu's existing secret check, and how this relates

`lintSecrets` (`src/main/mcp/memory-core.ts:366-371`) refuses text matching any of 8 patterns
(`:347-359`) and names the kind, never the value. It guards:

- `memory_append` (`validate.ts:381-382`) and `update_card.appendBody` (`tool-handlers.ts:1487-1498`);
- `update_card.replaceBody` and the board's body edits (`roadmap-ipc.ts:1452`, `:1491`);
- the dispatch boot prompt and the generate prompt (`roadmap-ipc.ts:1190`, `:1347`);
- `submit_manifest`, card by card (`roadmap-ipc.ts:1649`, `server.ts:326-327`).

**`create_card` is not linted.** Its body goes straight to `createCardFile` (`tool-handlers.ts:1395-1410`),
so the card's own premise ("Harnu already refuses card writes that contain a secret") holds for
`update_card` and the manifest, not for `create_card`. This is recorded as SCR-Q7; this spec does not
change it.

How the two relate:

1. **Different layer.** `lintSecrets` refuses a write _into Harnu's files_ (memory, cards, boot
   prompts). The scrubber rewrites what _the session_ keeps. Neither replaces the other.
2. **The scrubber removes a failure mode.** The automatic session digest writes through
   `appendMemoryEntry` (`memory-digest.ts:316`, `:393`), so a recap that quotes a secret fails with
   `BAD_ENTRY` today. With the scrubber, the recap quotes a placeholder and the write succeeds.
3. **Placeholders pass the lint.** Run over 108 placeholder samples (18 rule ids × 6 shapes:
   bare, `API_SECRET=`, `password:`, JSON `client_secret`, a URL's password, a bearer header),
   `lintSecrets`' patterns hit **0** (02 §4). So no Harnu write path will refuse a placeholder.
4. **One rule list, later.** The two lists differ: `lintSecrets` has 8 patterns, and its `openai-key`
   rule misses `sk-proj-…` and `sk-ant-…` keys, which have inner dashes. The scrubber's 18 rules are
   the superset. Sharing one module is SCR-Q4; this spec does not merge them.

## 12. Implementation outline (C-6)

Waves in dependency order. **S** is about a day, **M** a few, **L** a week or more.

| Wave | Size | What                                                                                                                                                                                                                                                                                                                                                                                                            | Depends on |
| ---- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| W0   | S    | **Spike.** Check every §13 assumption on the then-current CLI: tier order, #92533 interactive and with a tick, the mid-turn queue record, the `@`-mention attachment, the L1 race. Pin `minCli`.                                                                                                                                                                                                                | —          |
| W1   | M    | **The mod.** `resources/scrubber/`: the prototype hardened (rule table, allowlist, vault, `/scrub`), its tests run by `scripts/ci/mod-step.mjs` the way the Harnu mod's are, and an `api-surface.json` with a static test that the surface stays closed. Add `SHA` to the identifier gate's `ALLOWED_UPPER_PREFIXES` (`tests/no-client-identifiers.test.ts:62`), since the hash's dashed name trips it (03 §2). | W0         |
| W2   | M    | **Staging.** A second staged dir (`<userData>/scrubber/<stageKey>/secret-scrubber/`), inserted first among `--plugin-dir` flags for interactive, agent-dispatched and tick sessions. The global and per-folder settings.                                                                                                                                                                                        | W1         |
| W3   | M    | **Disclosure and audit in Harnu.** The Harnu mod relays `secret-scrubber.counts` (its `api-surface.json` gains the foreign read); a count on the session row; one Activity notice per folder; the `transcript` chip and `harnu-scrubber` row source; the "degraded" chip.                                                                                                                                       | W2         |
| W4   | M    | **L1.** Main rewrites `tool-results/*.txt` files of sessions it started, once the row that names them lands, with the same rule set compiled for Node. Only if W0 measures the race as safe; otherwise drop it and keep L1 documented.                                                                                                                                                                          | W1         |
| W5   | S    | **Outside Harnu.** The "Also outside Harnu" switch on the Mods row; the mod's own marketplace file for `/plugin install`.                                                                                                                                                                                                                                                                                       | W1         |
| W6   | S    | **Optional.** The `telemetry.log { to: 'collector' }` scrub (L6).                                                                                                                                                                                                                                                                                                                                               | W1         |

Repo contracts each wave owes:

| Contract                                           | W1  | W2                                                              | W3                        | W4  | W5           | W6  |
| -------------------------------------------------- | --- | --------------------------------------------------------------- | ------------------------- | --- | ------------ | --- |
| `CHANGELOG.md` entry                               | —   | yes                                                             | yes                       | yes | yes          | yes |
| `docs/user/` (a user-visible capability)           | —   | yes (new page `docs/user/secret-scrubber.md`, and `mods.md`)    | yes                       | yes | yes          | —   |
| `docs/harnu-features.md` + marker bump             | —   | yes (agents learn placeholders, resolution, `/scrub keep-next`) | yes (the count)           | —   | —            | —   |
| `design.md` + `en.json` + `pt-BR.json`             | —   | yes (the two switches)                                          | yes (count, chip, notice) | —   | yes (switch) | —   |
| New top-level `src/main/` file → `docs/user/` gate | —   | yes (`src/main/scrubber/…`)                                     | —                         | yes | —            | —   |

W1 alone changes nothing a user sees, because nothing stages the mod yet, so it owes no CHANGELOG
entry. Its `resources/scrubber/` source is covered by the CI mod step.

## 13. Assumptions the W0 spike must check

| Id  | Assumption                                                                                                                                                                                                                                                              | Why it matters                              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| A-1 | Inside one tier, an earlier `--plugin-dir` sits outside a later one, so its `session.append` hook runs first. Not documented; not run.                                                                                                                                  | L5: staged first ⇒ outermost.               |
| A-2 | #92533 stays closed on the shipping CLI, interactive and in a tick (verified once headless on 2.1.295, 03 §1.4).                                                                                                                                                        | §8.2, §8.3: the Bash hook.                  |
| A-3 | `$.ui.ask` inside a `tool.call` hook works interactively. The test answers `AskUserQuestion` itself; no interactive run resolved a placeholder.                                                                                                                         | §6.2 Bash resolution.                       |
| A-4 | A prompt typed mid-turn writes a `queue-operation` entry, and `prompt.submit`'s rewrite reaches it (`ref:143` says so). Not reproduced: the turn ended first. Also unknown: whether an interactive session's argv starting prompt is enqueued raw, as a `-p` prompt is. | L2's interactive half; dispatched sessions. |
| A-5 | An `@`-mentioned file's attachment payload is stored as made (`ref:143`) and so holds the raw file. Run A2 had no attachment with file content.                                                                                                                         | L8.                                         |
| A-6 | Main can rewrite a `tool-results/*.txt` file without racing a `Read` of it by the session.                                                                                                                                                                              | W4.                                         |
| A-7 | The tool record that `tool.call` returns is recorded whole. The runs saw a scrubbed `toolUseResult` for Bash; `Read`, `Grep`, `WebFetch` and MCP results were not run live.                                                                                             | §5.2 for non-Bash tools.                    |
| A-8 | The status line text carries no value. True by construction (`record()` writes a number), noted for review.                                                                                                                                                             | §7.                                         |

## 14. Open questions (C-7)

| Id     | Question                                                                                                                                                                               | Who decides                    |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| SCR-Q1 | Default on, or opt-in, for agent-dispatched sessions and ticks? This spec says on everywhere (§9.1). A false positive in an unattended run has no person to notice it.                 | Operator                       |
| SCR-Q2 | The high-entropy rule: on by default at 4.0 (measured, 01 §5), or off until a person opts in? It is the one rule that can redact a non-secret the model needs (a nonce, an opaque id). | Operator                       |
| SCR-Q3 | Should Edit/Write resolution confirm when the target file differs from the file the value was read from (a secret copied into a tracked file)? The prototype never asks.               | Operator, with security review |
| SCR-Q4 | Share one rule module between the scrubber and `lintSecrets` (and `redactTranscript`)? One list in Node and in the mod means a build step or a copied table with a parity test.        | Implementer (W1)               |
| SCR-Q5 | Images: drop image blocks in sessions that opt in to strict mode, or accept L3?                                                                                                        | Operator                       |
| SCR-Q6 | Offer a one-time "scrub my existing transcripts" pass from Harnu over `~/.claude/projects/`? It rewrites the operator's history files and cannot be undone.                            | Operator                       |
| SCR-Q7 | Add `lintSecrets` to `create_card` (§11)? Out of this card's scope, and a one-line fix.                                                                                                | Operator (a separate card)     |
| SCR-Q8 | Placeholder format. `[REDACTED:<rule>#<tag>]` is ASCII, greppable and passes `lintSecrets`. Keep it, or align with `redactTranscript`'s `<redacted>`?                                  | Implementer (W1)               |
| SCR-Q9 | Ask Anthropic for `prompt.submit` to run before the `-p` enqueue (L2), and for a hook on the persisted-output write (L1)?                                                              | Operator                       |

## 15. Repo contracts for this change (C-8)

This change adds only files under `docs/specs/T450-secret-scrubber/`. It is docs-only, so it owes no
CHANGELOG, `docs/harnu-features.md` or `docs/user/` change. English only. No client identifiers: the
repo paths named are this repo's own, and the measurement corpus is this repo. Checks run on the final
tree (`npx prettier --check`, `npx vitest run tests/no-client-identifiers.test.ts`) are in the report.
