# ADR-draft — Retry-storm breaker: one detector, two seats

**Status:** proposed (numbered on merge) · **Date:** 2026-10-09 (round 2) · **Spec:**
[`00-spec.md`](00-spec.md) · **Card:** T453

## Context

Idea 81 asks for a mod that notices the same failing tool call repeating and interrupts the loop: a
notice to the model, a dialog for the person, and a Harnu notification or blocker when nobody is
watching. Five constraints decide where each part can live:

1. **#92533 caution.** A pass-through Bash `tool.call` hook broke `Agent(isolation: "worktree")` in
   T389's smoke (`docs/studies/T389-smoke-evidence.md:628-650`), and the companion forbids one
   (SEC-9 (d), MOD-3). On 2.1.296 headless, a T450 verifier and this spec's run 8 saw isolation hold.
   It is unrun interactively and in a tick.
2. The companion may not call `$.mcp.call` (SEC-9 (b)), and a session Harnu spawns for an MCP agent has
   no Harnu MCP server at all (`src/main/pty.ts:812-819`).
3. Only Harnu's host knows whether a session is the operator's, an agent's, a tick's or a read-only
   reviewer's (`spawn-inject.ts:111-120`); the session sees an opaque spawn token.
4. A hook's `ask` is unreliable as a way to put a refusal to a person. In manual mode the engine's
   dialog does not draw the hook's reason, and in auto mode the mode settles the `ask` without anyone
   (`03-prototype-tests.md` run 10).
5. Storms are rare and short on this machine (`01-corpus-scan.md`: 19 exact runs ≥ 3 in 114,475
   calls, none past 5), and 16 of those 19 come from one engine-side cause. The feature must be cheap
   and must not harm the common case.

## Decision

**D1 — Observe through `session.append`, refuse through `tool.check`; no `tool.call`.** The mod
joins each `tool_use` (door `response`) to its `tool_result` (door `tool-result`) by id, counts
failures with `hooks/core.ts`, and appends its notice to the failing result's content. It needs
nothing from `tool.call`, so it holds to the caution whatever W0 finds. If #92533 proves gone,
`tool.call`'s `isReadOnly` may later replace the command-word heuristic in the reset rule, and nothing
else changes.

**D2 — Every refusal is a `deny` with its reason.** Never an `ask` (constraint 4). A `deny`'s reason
reached the model unattended and attended, in auto mode too (runs 3, 11). The person's override is the
dialog, which opens one failure before any refusal, and `/retry-breaker reset`. A refusal fires only
at level `enforce`; the default is `notice`.

**D3 — A separate bundled mod, `retry-breaker`, staged on its own gate.** Source
`resources/retry-breaker/`, staged as one more `--plugin-dir`, installable standalone outside Harnu.
Its staging depends on its own level, the CLI version floor and the sideload block, **not** on the
companion's mode. If it hung on the companion's provider, which returns no plan when the companion is
`off` (`spawn-inject.ts:79`), turning the companion off would silently turn the breaker off.

**D4 — Harnu's escalation runs in the host, from the same detector.** `hooks/core.ts` has zero
imports. Harnu's `src/main/retry-storm.ts`, beside `stall-detect.ts`, imports it and runs it over the
transcript tail it already parses (`claude-watcher.ts:512`, `transcript-truth.ts:389`). For
`agent`/`tick`/`read-only` sessions it raises an Activity notification and, optionally, a mission
blocker.

The twin cannot see `tool.check` verdicts or attendance, so it applies the permission exclusion by text
and uses the trust class. It sees resets and mutes only because the mod writes each into the
transcript as a system notice. Its errors run toward escalating, never toward silence. The mod never
calls Harnu.

**D5 — `HARNU_SESSION_ROLE`, delete-then-set.** Harnu sets `operator | agent | tick | read-only` on
every `claude` spawn that stages the breaker, PTY and tick alike. It first deletes any inherited value,
because the spawn env spreads `process.env` (`pty.ts:875-876`). It is a hint, not a credential.

**D6 — Fail open.** Every gating hook's `.catch` passes the engine's verdict and the unmodified row
through. This departs on purpose from the types' advice to fail a guard closed (`tool.check`,
`types/claude-code.d.ts:3964-3965`): a broken breaker must never refuse a call.

## Alternatives considered

| Alternative                                                        | Rejected because                                                                                             |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `tool.call` await-then-inspect (the idea's own design)             | #92533 caution and SEC-9 (d); the breaker must see Bash                                                      |
| `tool.call` on every tool but Bash, plus `session.append` for Bash | two observation paths for one rule; `session.append` alone covers every tool                                 |
| `ask` when a person is there, `deny` otherwise                     | live: the reason is not drawn in manual mode, and auto mode settles the `ask` itself (run 10)                |
| A feature inside `harnu-companion`                                 | closed surface (MOD-3); no actuators or guard/sentinel gates outside Harnu (P4W3); one switch for everything |
| Staging the breaker through the companion's provider               | the companion's `off` would silently disable it                                                              |
| Escalation from the mod through `$.mcp.call('harnu', …)`           | forbidden in the companion, absent in agent spawns, and a 30 s `pending` under "Ask before agent actions"    |
| Escalation through T447's `$.harnu` noun                           | rides the same `$.mcp.call`, answers `NO_MCP` where it is needed, and is not built                           |
| Host only (no mod)                                                 | the host cannot put a sentence in the model's next request or refuse a call                                  |
| `classic.PostToolUseFailure` to see failures                       | never observed firing in T389's smoke (`01-contract.md:665`)                                                 |
| `$.ui.ask` as the dialog                                           | 2–4 labels, no side-by-side errors, rejects in `-p`                                                          |

## Consequences

- One definition, two seats: the mod and the host count with the same file over the same rows. The
  host strips the mod's notice before hashing an error, because the transcript stores it.
- Harnu's staging must handle more than one bundled mod, and the Mods audit must discover every staged
  directory (it knows one today, `mods-audit.ts:618`).
- The Mods audit has no chip for `session.append`. The breaker shows `prompts`, `permissions`,
  `model`, `env` and `terminal`, but nothing says it rewrites results, so a `transcript` chip is owed.
- Outside Harnu the breaker works fully in-session and escalates nowhere.
- Most of what it catches on this machine disappears if the engine's `SendMessage` schema stops
  contradicting its own description (`00-spec.md` §15 F-1). The recommended build is therefore the
  in-session mod alone at level `notice`, with the host escalation built only if a re-scan after that
  fix still shows storms in unattended runs.
