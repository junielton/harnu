# ADR-draft — The secret scrubber is a standalone bundled mod that fails closed

**Status:** proposed (numbered when merged) · **Date:** 2026-10-09 · **Card:** T450 · **Spec:**
[`00-spec.md`](00-spec.md)

## Context

A secret that enters a Claude Code session is read by the model and stored in the transcript file,
under `~/.claude/projects/`. Harnu then reads that file to build session digests, previews and project
memory, so the secret spreads further. Today Harnu catches secrets only at its own doors:

- `lintSecrets` refuses a memory or card write, or a boot prompt, that holds one
  (`src/main/mcp/memory-core.ts:366-371`).
- `redactTranscript` masks what an MCP read discloses (`src/main/mcp/transcript-redact.ts:72`).

Both act after the model and the file already have the secret.

A mod's `session.append` hook sees every row the conversation keeps before it is stored and before
the model reads it (`reference.md:137`, 2.1.295). Live runs on 2.1.295 and 2.1.296 showed that this
hook alone leaves the tool's structured record (`toolUseResult`) raw. A `tool.call` hook answering with
a scrubbed result closes that gap; a `prompt.submit` rewrite narrows the queue record
([`03-live-runs.md`](03-live-runs.md) §1.1, §1.2).

Harnu already ships one mod, the Harnu mod (`resources/companion/`, ADR-0018). Where should the
scrubber live, and what should it do when it breaks?

## Decision

**The scrubber is a mod of its own, `secret-scrubber`, which Harnu bundles under `resources/scrubber/`
and stages as a separate `--plugin-dir`, first among the plugin dirs, in every session Harnu starts.
It fails closed.**

### Sub-decisions

1. **D1 — Not inside the Harnu mod.** The Harnu mod's closed surface allows `tool.call` only on
   `Edit`/`Write`/`NotebookEdit` and Harnu's MCP tools. A static test forbids any Bash matcher (T389
   `00-master.md:524`, MOD-3; risk R8 `:605`). Its hooks return `next(e)` on any failure (MOD-2,
   `:523`), and it goes dormant without a spawn token (`resources/companion/hooks/register.ts:484-491`).
   The scrubber needs a Bash `tool.call` hook, must fail closed, and must behave the same outside
   Harnu. Folding it in would break MOD-2 and MOD-3, or the scrubber.
2. **D2 — Not main-process code.** Main sees a row only after it is stored and read. It owns only
   what a mod cannot reach: staging, settings, the audit row, the count display, and the persisted
   large outputs the engine writes before any hook (leak L1).
3. **D3 — Fail closed.** A row the scrubber cannot check is stored with its text withheld. A prompt is
   dropped. A tool result is withheld after the tool ran. Each runs through `.catch`
   (`d.ts:9314-9340`). The engine never refuses a row (`reference.md:141`), so withholding words is the
   strongest fail-closed answer `session.append` has.
4. **D4 — Placeholders resolve, with consent where the value can leave.** `Edit`/`Write`/`NotebookEdit`
   get the real value back silently, so files are never corrupted. `Bash` gets it only after the
   person allows it. Other tools never do. The vault lives in a module variable, never in `$.state`
   or `$.store`.
5. **D5 — Counts only.** The mod publishes `{ total, byRule }` in `$.state`. Harnu reads it through
   the Harnu mod. No value and no placeholder tag is ever logged.
6. **D6 — Staged first.** The scrubber's `--plugin-dir` comes before the Harnu mod's, on the
   assumption (A-1, unverified) that an earlier dir sits outside a later one within the `user` tier. An
   organization that needs a guarantee installs it at the `prepend` tier.

## Alternatives rejected

- **A wave of the Harnu mod.** Rejected by D1. It would also put a security-relevant hook behind the
  Harnu mod's off/shadow/active rollout modes, which follow a CLI version gate, not a privacy choice.
- **Rewrite transcripts at rest from main.** Too late (the model has read the secret), and it races
  the engine's own appends to the same file.
- **Fail open, like the Harnu mod.** A scrubber that passes the secret when it breaks gives a false
  sense of safety. The cost of failing closed is a withheld row, which is visible and recoverable.
- **Redact without resolution.** Measured harm: an `Edit` of a `.env` file the model has read would
  write the placeholder text into the file, or fail to match.

## Consequences

- A second bundled mod to stage, version-gate and audit. The Mods tab gains a row source
  (`harnu-scrubber`) and a `transcript` chip.
- Every Harnu session carries a Bash `tool.call` hook. #92533 (a pass-through Bash hook breaking
  worktree-isolated agents) did not reproduce on 2.1.295 ([`03-live-runs.md`](03-live-runs.md) §1.4).
  The Harnu mod's own ban stays. The scrubber's staging is gated on the W0 spike re-checking it.
- Harnu's digests stop failing `lintSecrets` on recaps that quote a secret.
- Some leaks stay open and are documented, not hidden: the persisted large output, the `-p` queue
  record, media, the pre-rewrite screen, plugins above the scrubber, and collector telemetry
  ([`00-spec.md`](00-spec.md) §5.3).

## Kill criteria

- #92533 or a successor reappears: a Bash `tool.call` hook breaks worktree isolation on a supported
  CLI. Then drop the Bash hook (keep `session.append` and `prompt.submit`), and document `toolUseResult`
  for Bash as an open leak.
- The engine starts storing `toolUseResult` from the `session.append` rewrite, or adds a hook on the
  persisted-output write. Then the `tool.call` record scrub, or W4, is no longer needed.
- More than one false positive per MB on the W0 transcript corpus. Then turn the high-entropy rule off
  by default.
