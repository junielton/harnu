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
hook alone leaves the tool's structured record (`toolUseResult`) raw, and an errored call's stored
text raw. A `tool.call` hook closes both: it answers with a scrubbed result, or denies with the
redacted text when the call errored. A `prompt.submit` rewrite narrows the queue record
([`04-live-runs.md`](04-live-runs.md) §1.1, §1.2, §1.4).

Harnu already ships one mod, the Harnu mod (`resources/companion/`, ADR-0018). Where should the
scrubber live, and what should it do when it breaks?

## Decision

**The scrubber is a mod of its own, `secret-scrubber`, which Harnu bundles under `resources/scrubber/`
and stages as a separate `--plugin-dir` in every session Harnu starts, right after the Harnu mod. Its
safety path fails closed, its bookkeeping fails open, and two live off switches bound a failure.**

### Sub-decisions

1. **D1 — Not inside the Harnu mod.** The Harnu mod's rules forbid what the scrubber needs:
   - **MOD-3** allows `tool.call` only on `Edit`/`Write`/`NotebookEdit` and Harnu's MCP tools, and a
     static test forbids any Bash matcher (T389 `00-master.md:524`; risk R8 `:605`).
   - **SEC-9(d)** forbids "Any `tool.call` matcher on Bash" (`:502`).
   - **MOD-2** makes its hooks return `next(e)` on any failure (`:523`).

   The scrubber needs a Bash `tool.call` hook and must fail closed. Folding it in would break those
   rules, or the scrubber.

2. **D2 — Not main-process code.** Main sees a row only after it is stored and read. It owns only
   what a mod cannot reach: staging, settings, the audit row, the count display, and the persisted
   large outputs the engine writes before any hook (leak L1).
3. **D3 — Safety fails closed, bookkeeping fails open, and the blast radius is bounded.**
   - **Safety failures.** A row the scrubber cannot check is stored with its text withheld. A prompt
     is dropped. A tool result is withheld after the tool ran, with a text that says the tool ran and
     must not be run again: a deny "undoes nothing" (`d.ts:12706-12708`). Each runs through `.catch`
     (`d.ts:9314-9340`). The engine never refuses a row (`reference.md:141`), so withholding words is
     the strongest fail-closed answer `session.append` has.
   - **Bookkeeping failures.** A failed count write changes nothing.
   - **The blast radius.** The mod is on by default, staged everywhere, and hooks every tool. So a
     scrub bug would stall every Harnu session. Three consecutive failures trip a breaker that tells
     the person how to turn it off. Two live off switches reach running sessions: `/scrub off`, and
     Harnu's Settings toggle, which a running scrubber reads from a flag file every 5 s, both ways.
   - **The flag is not authenticated.** Any process running as the operator's user can create it, the
     session's own Bash included. Nothing the mod can read is out of that Bash's reach, so no channel
     can be made unforgeable against it. The design is tamper evidence and recovery:
     - Harnu owns the flag's lifecycle and deletes a flag it did not write, with an operator notice.
     - A call that names the flag plainly is refused.
   - **Off never writes a placeholder's text into a file.** Writer calls that carry one are still
     refused.
4. **D4 — Placeholders resolve only where the person agreed.**
   - **Edit/Write/NotebookEdit:** never into a tracked file; silently into a gitignored file or a path
     the repo lists; after a question for any other path. The target is classified at its real path,
     links followed, by `git` run from that path's own folder. Run from the session's folder, git
     misreads a worktree nested in another repo's ignored dir, and an ignored link
     ([`04-live-runs.md`](04-live-runs.md) §1.7).
   - **Bash:** after a question.
   - **Nobody to ask:** refused.
   - **Other tools:** never.

   The scrubber is not an exfiltration control. The rule is only that it never makes a new copy of a
   secret the person did not agree to. The vault lives in a module variable, never in `$.state` or
   `$.store`.

5. **D5 — A placeholder this session cannot resolve stops the call.** A resume (how Harnu wakes a
   parked session), a reload or a new process empties the vault, while the salt persists. A call that
   carries an unknown placeholder is refused, with a message telling the model to re-read the source,
   which mints the same placeholder with its value.
6. **D6 — Counts only.** The mod publishes `{ total, byRule, off, tripped }` in `$.state`. Harnu reads it through
   the Harnu mod. No value and no placeholder tag is ever logged.
7. **D7 — Staged second.** MOD-9 keeps the Harnu mod first (`00-master.md:530`), and the scrubber
   comes right after it, before every other dir. The Harnu mod hooks no `session.append` and no
   `tool.call`. The order matters only under assumption A-1 (unverified): that an earlier dir sits
   outside a later one within the `user` tier. An organization that needs a guarantee installs the
   scrubber at the `prepend` tier.

## Alternatives rejected

- **A wave of the Harnu mod.** Rejected by D1. It would also put a security-relevant hook behind the
  Harnu mod's off/shadow/active rollout modes, which follow a CLI version gate, not a privacy choice.
- **Rewrite transcripts at rest from main.** Too late (the model has read the secret), and it races
  the engine's own appends to the same file.
- **Fail open, like the Harnu mod.** A scrubber that passes the secret when it breaks gives a false
  sense of safety. The cost of failing closed is a withheld row, which is visible and recoverable.
- **Redact without resolution.** Measured harm: an `Edit` of a `.env` file the model has read would
  write the placeholder text into the file, or fail to match.
- **Resolve silently into any file.** Round 1 did this, and a verifier showed the hole: write the real
  value into `/tmp/x` or a tracked file, then send it with a command that names no placeholder.
- **Keep the vault on disk, so a resume keeps it.** That writes every secret the session saw to disk,
  the thing the mod exists to prevent.
- **Answer an errored result with a scrubbed one.** Core refuses it ("does not match its output
  shape"; [`04-live-runs.md`](04-live-runs.md) §1.4).

## Consequences

- A second bundled mod to stage, version-gate and audit. The Mods tab gains a row source
  (`harnu-scrubber`) and a `transcript` chip.
- Every Harnu session carries a Bash `tool.call` hook. #92533 (a pass-through Bash hook breaking
  worktree-isolated agents) was reproduced on 2.1.287 (T389 smoke B4). It did not reproduce on 2.1.296
  in a marker run that proves the hook fired on each isolated Bash call
  ([`04-live-runs.md`](04-live-runs.md) §1.6). The Harnu mod's own ban stays. The scrubber's staging
  is gated on the W0 spike re-checking it interactively and in a tick.
- The mod calls `git` (`$.process.run`), so the Mods tab shows a `process` chip next to `files`,
  `prompts` and `tool-calls`.
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
- More than one false positive per MB on the W0 transcript corpus. Then the `high-entropy` rule stays
  off by default, as it ships.
- The breaker trips in more than a handful of sessions per week. Then the safety path has a bug class
  the tests miss, and the default goes to off until it is found.
