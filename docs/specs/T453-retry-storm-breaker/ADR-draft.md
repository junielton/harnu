# ADR-draft — Retry-storm breaker: one detector, two seats

**Status:** proposed (numbered on merge) · **Date:** 2026-10-09 · **Spec:**
[`00-spec.md`](00-spec.md) · **Card:** T453

## Context

Idea 81 asks for a mod that notices the same failing tool call repeating and interrupts the loop:
a notice to the model, a dialog for the person, and a Harnu notification or blocker when nobody is
watching. Four constraints decide where each part can live:

1. A `tool.call` hook whose matcher reaches `Bash`, even a pass-through one, breaks
   `Agent(isolation: "worktree")` (#92533; ADR-0018 D6, `docs/adr/0018-…md:121-127`). The companion
   forbids it (SEC-9 (d), MOD-3).
2. The companion may not call `$.mcp.call` (SEC-9 (b)), and a session Harnu spawns for an MCP agent
   has no Harnu MCP server at all (`src/main/pty.ts:812-819`).
3. Only Harnu's host knows whether a session is the operator's, an agent's or a Scheduler tick's
   (`spawn-inject.ts:111-120`); the session sees an opaque spawn token.
4. On this machine, storms are rare and short (`01-corpus-scan.md`: 23 exact runs ≥ 3 in 112,674
   calls, none past 4), so the feature must be cheap and must not harm the common case.

## Decision

**D1 — Observe through `session.append`, refuse through `tool.check`; never `tool.call`.** The mod
joins each `tool_use` (door `response`) to its `tool_result` (door `tool-result`) by id, counts
failures, and appends its notice to the failing result's content. It refuses a repeat by answering
the call's `tool.check` with `ask` (a person is there) or `deny` (nobody is), always with a reason.
Proven in live headless runs, including a worktree-isolated agent whose Bash ran in its own worktree
(`03-prototype-tests.md` runs 3, 5, 8, 9).

**D2 — A separate bundled mod, `retry-breaker`, not a companion feature.** Source
`resources/retry-breaker/`, staged by Harnu as one more `--plugin-dir` beside the companion, and
installable on its own outside Harnu. The companion's hook surface is closed and its outside-Harnu
profile excludes actuators and the guard/sentinel gates; the breaker is both. A separate mod also
gets its own switch and its own row in Settings → Mods.

**D3 — Harnu's escalation runs in the host, from the same detector.** The detector is one file with
zero imports (`hooks/core.ts`). The mod runs it in-session; Harnu's main process imports it and runs
it over the transcript it already parses (`claude-watcher.ts:512`, `transcript-truth.ts:389`), and
for sessions whose trust class is `agent` or `tick` raises an Activity notification and, optionally, a
mission blocker. The mod never calls Harnu.

**D4 — Harnu tells the session who is watching, through `HARNU_SESSION_ROLE`.** `operator`,
`agent` or `tick`, from the trust class, on the spawn env. It is a hint that only makes the breaker
stricter when forged toward `agent`, and shows a dialog nobody sees when forged toward `operator`.

**D5 — Fail open.** Every gating hook's `.catch` passes the engine's verdict and the unmodified row
through. A broken breaker never refuses a call.

## Alternatives considered

| Alternative                                                        | Rejected because                                                                                                                                 |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tool.call` await-then-inspect (the idea's own design)             | #92533; forbidden for Bash by the companion's rules, and the breaker must see Bash                                                               |
| `tool.call` on every tool but Bash, plus `session.append` for Bash | two observation paths for one rule; `session.append` alone covers every tool (D1)                                                                |
| A feature inside `harnu-companion`                                 | closed surface (MOD-3); no actuators or the guard/sentinel gates outside Harnu (P4W3); one switch for everything                                 |
| Escalation from the mod through `$.mcp.call('harnu', …)`           | forbidden in the companion, absent in agent spawns, and a 30 s `pending` under "Ask before agent actions"                                        |
| Escalation through T447's `$.harnu` noun                           | rides the same `$.mcp.call`, answers `NO_MCP` where it is needed, and is not built                                                               |
| Host only (no mod)                                                 | the host cannot put a sentence in the model's next request, and refusing needs the legacy 3.5 s `PreToolUse` park the companion work is retiring |
| `classic.PostToolUseFailure` to see failures                       | never observed firing in T389's smoke (`01-contract.md:665`)                                                                                     |
| `$.ui.ask` as the dialog                                           | 2–4 labels, no side-by-side errors, rejects in `-p`                                                                                              |

## Consequences

- One definition, two seats: the mod and the host count the same way because they run the same
  file. The host strips the mod's notice before hashing an error, because the transcript stores it.
- Harnu's staging must handle more than one bundled mod, and the Mods audit must discover every
  staged directory (it knows one today, `mods-audit.ts:618`).
- The Mods audit has no chip for `session.append`; the breaker shows `prompts`, `permissions`,
  `model`, `env` and `terminal` but nothing says it rewrites results. A `transcript` chip is owed.
- Outside Harnu the breaker works fully in-session and escalates nowhere.
- What a hook's `ask` does in `auto`, `bypassPermissions` and `dontAsk` is unproven; until a spike
  proves it, the mod answers `deny` there.
