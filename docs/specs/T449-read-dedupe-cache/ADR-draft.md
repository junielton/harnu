# ADR-draft — A read-dedupe cache, if built, is a standalone mod, not part of the Harnu mod

**Status:** proposed (numbered when merged) · **Date:** 2026-10-09 · **Card:** T449 · **Spec:**
[`00-spec.md`](00-spec.md)

## Context

Idea 8 of the operator's ideation report proposes a mod that answers a re-`Read` of an unchanged
file in-process, by returning a result from a `tool.call` hook without calling `next`. The spec
shows the mechanism works on Claude Code 2.1.296 (a prototype and twenty-seven live runs), and that
an answer is safe only behind eight checks: the file's metadata, a hash of the same lines, the
earlier result still present in the local message list, no idle gap that would let the engine clear
tool results on the server, and a margin to the auto-compaction threshold, plus a repair note if a
compaction still follows an answer. Two of those rest on assumptions a spike must test (`00-spec.md`
§5, §13).

Three facts frame where such a mod should live:

- **It needs nothing from Harnu.** It reads the file system and the session's own messages, and
  writes a status line and its own `$.state`. No host fact, no MCP verb, no Harnu identity.
- **The Harnu mod has a closed surface.** ADR-0018 makes `harnu-companion` Harnu's integration
  substrate, and the T389 master spec closes its hook surface: `tool.call` is hooked with exactly
  two matchers, `Edit|Write|NotebookEdit` and `/^mcp__(harnu|capy)__/` (MOD-3,
  `docs/specs/T389-companion-mod/00-master.md`:524). A feature of the companion with no fact family
  runs only with its key on, the companion mode not `off` and a live lease with Harnu's host
  (`01-contract.md`:1029-1031).
- **It rewrites what the model reads, for little.** Measured on this machine, it would have answered
  9 of 10,209 Reads in 55 active days, about 14 thousand tokens (`01-measurement.md`). Claude Code
  ships its own version of the feature and keeps it switched off with a server-side flag
  (`00-spec.md` §4.1).

## Decision

If the operator decides to build it (spec OQ-1), the read-dedupe cache ships as **a standalone mod
named `read-dedupe`**, installed by the person with
`/plugin install read-dedupe --marketplace <owner>/<repo>` at user scope. Harnu does not bundle it,
stage it, or carry a switch for it. Harnu's only contact with it is the row the Settings → Mods
audit tab already draws for any installed mod (chips `files` and `tool-calls`).

## Alternatives rejected

- **A step inside `harnu-companion`, behind a feature key.** It would need MOD-3 amended for a third
  `tool.call` matcher; it would stop working whenever the Harnu host is away, though it needs
  nothing from it; and it would add the companion's first hook that changes model-visible content to
  the module every Harnu session loads, for a measured 0.08 % of Read tokens.
- **A second mod Harnu bundles and stages with its own `--plugin-dir`.** The pattern is sound (the
  T447 `harnu` mod is specified that way) but needs staging, a Settings switch and per-folder state.
  It is worth building once, as a catalog for several in-process ideas, not for this one (spec
  OQ-5).
- **Harnu main-process code.** Impossible: only an in-process `tool.call` hook can answer in place
  of a tool. A settings `PreToolUse` hook can allow or deny, not supply a result.

## Consequences

- **Same behaviour inside and outside Harnu.** An installed mod loads in every `claude` session on
  the machine. A Harnu session gets nothing unless the person installed it.
- **No Harnu contract changes.** No MCP verb, ACK, grant or Harnu UI is added, so
  `docs/harnu-features.md` is untouched. If the source lives in this repository it owes a
  `CHANGELOG.md` entry and a `docs/user/mods.md` section (spec §12).
- **The companion's surface stays closed.** MOD-3 and the lease rules are unchanged.
- **Drift is the mod's own.** It depends on Read's `file_unchanged` output variant and on
  `$.session.messages({ as: 'api' })` reflecting compaction; each CLI bump re-runs its
  `claude plugin validate` and `claude plugin test`, as the companion's `mod` step does.
- **The Mods audit tab shows it as a `tool-calls` mod.** The static permission-hooker detector would
  count it (spec OQ-4).

## Kill criteria

Any one of them retires the mod, or stops it from being built:

- A fresh run of the spec's scanner shows unchanged re-reads below the share the operator set under
  OQ-1.
- Anthropic switches the engine's own dedupe on (`tengu_read_dedup_killswitch` off): the engine then
  does the same job beneath the mod, and the mod steps aside by design.
- One confirmed false answer: the model told a file is unchanged when the earlier content was not in
  its context, or the file had changed.
