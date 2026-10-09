# ADR-draft — The verification gate is a separate bundled mod, and its check is a `verify:` key in `WORKTREE.md`

**Status:** proposed (numbered at merge) · **Date:** 2026-10-09 · **Card:** T452 · **Spec:**
[`00-spec.md`](00-spec.md)

## Context

Ideas 44 and 68 of the mods ideation report propose a gate on "done": when a session claims its
work is finished, the claim goes through only if the repo's check ran green after the session's
last edit. A red check turns the claim into a refusal with the failing output. The spec settles two
architectural questions: where the gate runs, and where its command comes from.

Facts that constrain both (cited in full in the spec):

1. **The gate must see the session's own edits and runs, and must run a process.** Only code inside
   the `claude` process sees every tool call, its subagents' included, before and after it runs.
   Harnu's main process installs no `PostToolUse` hook (`src/main/hook-installer.ts:39-51`), and
   its MCP transport has no per-session identity (`src/main/mcp/tool-catalog.ts:1312`). So main
   cannot tell an author's claim from an orchestrator's.
2. **The companion is forbidden exactly what the gate needs.** T389 SEC-9 forbids `$.process.run`
   (a), `$.mcp.call` (b) and any Bash `tool.call` matcher (d) in `harnu-companion`
   (`docs/specs/T389-companion-mod/00-master.md:502`), enforced statically
   (`scripts/ci/api-surface-scan.mjs:133-175`). Its `tool.call` surface is closed to two matchers
   (MOD-3, `00-master.md:524`).
3. **The host cannot run the check for the companion yet.** No `ask` kind is registered
   (`src/main/companion/host-core.ts:113, :498` has no caller; `server.ts:563-564` answers
   `FEATURE_DISABLED`). An ask tranche is ≤20 s (MOD-5), while this repo's check measured about 53 s
   (spec §8.2). MOD-5 also forbids an ask when the session is not interactive.
4. **A `tool.call` hook on Bash breaks worktree-isolated subagents**, even as a pass-through
   (`docs/studies/T389-smoke-evidence.md:628-650`). `tool.check` on Bash does not. That held in
   the spec's live run P4.
5. **T447 will guard Harnu's MCP server against direct mod calls.** Its `harnu` mod denies every
   `$.mcp.call` into `harnu`/`capy` from any mod but itself (T447 `03-security.md:50-56`). It
   offers `missionLog`, `missionBlockerSet` and `missionBlockerClear`, scoped to the caller's own
   steps (`03-security.md:23`).
6. **No command exists to run.** A Mission step carries a verification level, not a command
   (`src/main/mission-core.ts:76-95`). A card AC carries a `verify:` kind by skill convention, with
   no parser (`resources/skills/skills/orchestrate-delivery/SKILL.md:114`). `WORKTREE.md` has no
   such key, and drops unknown keys with a warning (`src/main/worktree-manifest.ts:139-148,
:266-268`).

## Decision

**D1. A third bundled mod, `harnu-verify-gate`.** It holds detection, the check run and the
answer. Harnu stages it like the companion: an immutable versioned copy, one more `--plugin-dir`,
injected per PTY spawn (ADR-0018 D1). Harnu's main process holds only the preference (global, per
folder) and passes the resolved mode as one env var, `HARNU_VERIFY_GATE`. The mod is a plain
plugin too: outside Harnu it runs from its own `userConfig`.

**D2. Its hooks, chosen for fact 4.** `tool.check` gates Bash claims (`gh pr create`,
`gh pr ready`). `classic.PostToolUse` and `classic.PostToolUseFailure` feed the session's ledger of
edits and check runs. `tool.call` gates the Harnu MCP claims (`mission_update_step` with
`proof: 'claimed'`, `move_card` to `review`). The mod never registers `tool.call` on Bash, and a
static test pins that, as for the companion.

**D3. Every hook fails open, through `.catch`.** A refusal comes only from a verdict: a red check,
or a check the gate could not finish (the session can run it itself). A gate that throws lets the
claim through. Independent verification downstream is the real safeguard, and a broken gate must
never wedge an unattended executor.

**D4. The command is a `verify:` key in `WORKTREE.md`.** It takes one POSIX command line, or a
list joined with `&&`, the same contract as `setup` (ADR-0005). `WORKTREE.local.md` overrides it.
The mod reads the file itself, so it works outside Harnu. Harnu's resolver learns the key, so it
stops warning about it (server dependency D-1). The command never comes from the model, a card body
or any field an agent can write.

**D5. Mission writes go through T447's noun, never around it.** The receipt line in the Mission
Log and the step blocker on red wait for `$.harnu.missionLog` and `missionBlockerSet`/`Clear`. The
gate lists `harnu` under `dependencies`. It never calls `$.mcp.call('harnu', …)` directly, which
T447's guard would refuse.

**D6. It is a self-check, never a verification.** The gate never calls `mission_verify_step`,
never sets a proof label and never ticks a check. The delivery-verifier and `mission_verify_step`
from a non-authoring session stay the only way a step becomes `verified`.

## Alternatives considered

| Alternative                                        | Why not                                                                                                                                                                                                     |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The gate inside `harnu-companion`                  | Facts 2 and 4. It would need SEC-9 (a), (b) and (d) reopened for the one mod that is staged into every session and whose floor ADR-0018 D13 set on purpose.                                                 |
| The companion asks the host to run the check       | Fact 3: no ask broker exists, the tranche is shorter than the check, headless sessions get no ask, and it would do nothing outside Harnu. Worth revisiting if a host-side runner appears for other reasons. |
| Main process only, e.g. the server refusing claims | Fact 1: the server cannot see edits, runs or the caller. It would gate the orchestrator, who edited nothing, and miss the executor, who has no MCP.                                                         |
| Inside T447's `harnu` mod                          | That mod is the noun and its guard. Adding a process runner to it widens the one mod every Harnu-aware mod depends on.                                                                                      |
| The command in a new Mission step field            | The most common executor shape, an MCP-spawned child, cannot read its mission at all (no Harnu MCP). Per-step commands stay an open question.                                                               |
| The command guessed from `package.json`            | A guess runs the wrong gate in any repo whose real check is not `npm test`.                                                                                                                                 |
| `$.mcp.call('harnu', …)` for Mission writes now    | Fact 5: breaks the day T447 ships, and bypasses the scoping T447 adds.                                                                                                                                      |

## Consequences

- A second process-running mod ships in every Harnu session. The Mods tab discloses it with the
  `process`, `files`, `tool-calls`, `permissions` and `env` chips (spec §11.3). The user docs say
  why it needs each.
- `WORKTREE.md` gains a meaning beyond provisioning: it now also says what "green" is for the repo.
  The worktree-manifest skill and `docs/user/` must teach the key.
- Executors in the most common shape (MCP-spawned, no Harnu MCP) get the Bash gate and the
  `SendMessage` receipt, but no Mission write. Their orchestrator stays the one that records it.
- The gate's value is bounded by its honesty model: it catches a stale "all tests pass", not a
  forged receipt. That is stated as a non-goal, and the verifier never counts the receipt as proof.
- The mod has its own CLI ceiling and `api-surface.json`, checked by `scripts/ci/mod-step.mjs`, so a
  Claude Code update that changes a hook it relies on forces `annotate` instead of a silent change.
