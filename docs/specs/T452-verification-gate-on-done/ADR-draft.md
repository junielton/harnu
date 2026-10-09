# ADR-draft — The verification gate is a separate bundled mod that runs only an operator-approved command

**Status:** proposed (numbered at merge) · **Date:** 2026-10-09 (round 2) · **Card:** T452 ·
**Spec:** [`00-spec.md`](00-spec.md)

## Context

Ideas 44 and 68 of the mods ideation report propose a gate on "done": when a session claims its
work is finished, the claim goes through only if the repo's check ran green after the session's
last edit. A red check turns the claim into a refusal with the failing output. The spec settles
three architectural questions:

- where the gate runs;
- where its command comes from;
- who is allowed to choose that command.

Facts that constrain them (cited in full in the spec):

1. **The gate must see the session's own edits and runs, and must run a process.** Only code
   inside the `claude` process sees every tool call's outcome, its subagents' included. Harnu's main
   process sees each **attempt** through its `PreToolUse` `*` hook
   (`src/main/hook-installer.ts:41-50`) but no outcome: it installs no `PostToolUse` (:39). Its MCP
   transport has no per-session identity (`src/main/mcp/tool-catalog.ts:1312`).
2. **Running a command from a hook bypasses Claude's permission system.** That matters most in the
   sessions Harnu deliberately weakened: an MCP-spawned child has its permission flags downgraded
   (`forceDowngradePermission`, `src/main/pty.ts:811-818`).
3. **The working tree belongs to the session.** A session can edit `WORKTREE.md` and
   `WORKTREE.local.md` in its worktree, and in `acceptEdits` it does so without asking. A worktree
   may also hold an untrusted branch, such as a fork's PR. Round 1 of this spec read the command
   from there. The round-1 grading found that this is a two-step code-execution path: set
   `verify: node -e …`, then run `gh pr create`.
4. **Harnu already has a trusted path for repo commands.** It reads `setup` from the repo's main
   checkout (`readManifestSources(repoRoot)`, `src/main/worktree-ipc.ts:339-350`). It discloses
   setup verbatim before an MCP `create_worktree` (`worktree-ipc.ts:470-477`,
   `DisclosedWorktreeCommands`, `src/main/worktree-manifest.ts:613-625`, "the RCE surface"), and runs
   it once.
5. **The companion is forbidden what the gate needs.** T389 SEC-9 forbids process runs (a),
   `$.mcp.call` (b) and a Bash `tool.call` matcher (d) in `harnu-companion`, and SEC-4 forbids
   security-relevant reads from env, cwd or project files
   (`docs/specs/T389-companion-mod/00-master.md:497, :502`).
6. **The host cannot run the check for the companion yet.** No `ask` kind is registered
   (`src/main/companion/host-core.ts:113, :498`; `server.ts:563-564`). Ask tranches are ≤20 s,
   against this repo's measured ~53 s check, and are not allowed in non-interactive sessions (MOD-5).
7. **A `tool.call` hook on Bash once broke worktree-isolated subagents.** That was on an earlier
   build (`docs/studies/T389-smoke-evidence.md:628-650`, issue #92533). A probe on 2.1.296 headless
   found isolation intact (the T450 verifier). `tool.check` and classic hooks are safe either way.
8. **T447 will guard Harnu's MCP server against direct mod calls**, and offers scoped Mission writes
   through its noun (T447 `03-security.md:23, :50-56`).
9. **No command exists to run today.** A step carries a verification level (`src/main/mission-core.ts:76-95`).
   A card AC carries a `verify:` kind by convention only. `WORKTREE.md` has no such key
   (`worktree-manifest.ts:139-148`).

## Decision

**D1. A third bundled mod, `harnu-verify-gate`: the first Harnu-staged mod that runs a process.**

- It holds detection, the run and the answer.
- Harnu stages it like the companion: an immutable versioned copy, one more `--plugin-dir` per PTY
  spawn (ADR-0018 D1).
- Outside Harnu it is a plain plugin.

**D2. The command is the operator's, never the model's.**

- **Inside Harnu:**
  - Harnu's main process reads the `verify:` key from the repo's **main checkout**, with the
    existing manifest resolver.
  - It shows the parts verbatim and keys them by a SHA256 hash.
  - It passes them to the session at spawn (`HARNU_VERIFY_CMD`) **only when the operator has
    approved that exact hash** for the repo.
  - A changed command is a new hash, which nobody approved, so the gate runs nothing and asks again.
  - The mod never reads the working tree.
- **Outside Harnu:**
  - The default mode is **annotate**, which runs nothing.
  - `enforce` runs only the `check` option the person set in their own settings.

**D3. The gate meets the intent of SEC-4 and SEC-9, not just their letter.**

- **Project files and cwd: nothing read.** The only env read is two literal names Harnu sets at
  spawn; the model cannot change the process env.
- **Process runs** are limited to approved, disclosed text, never a generic runner.
- **No `$.mcp.call`:** W3's Mission writes go through T447's noun.
- **No Bash `tool.call`.**
- A static profile in `scripts/ci/api-surface-scan.mjs` enforces this, as it does for the
  companion: no `fs.*`, no `http.*`, no `mcp.call`, and `process.spawn` only in the runner.

**D4. Its hooks.**

| Hook                                         | Role                                                                                                                              |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `tool.check`                                 | gates Bash claims (`gh pr create`, `gh pr ready`)                                                                                 |
| `classic.PostToolUse` / `PostToolUseFailure` | feed the session's ledger of edits and runs, part by part                                                                         |
| `classic.SessionStart`                       | seeds the ledger on resume and clear                                                                                              |
| `tool.call`                                  | gates the Harnu MCP claims (`mission_update_step` with `proof: 'claimed'`, `move_card` to `review`) and `message_session` reports |
| `session.send`                               | appends a receipt line to outgoing reports                                                                                        |

**D5. The run is a `$.process.spawn` loop.**

- An abort of the claim's dispatch (Esc) kills the child and records nothing.
- A timer's `return()` enforces the per-part timeout (default 300 s, 600 at most).
- `$.process.run` is not used: it takes no abort signal.

**D6. Every hook fails open, through `.catch`.** A refusal comes only from a verdict:

- a red check;
- a check that could not finish (the session can run it itself);
- a resumed session treated as edited.

**D7. Mission writes go through T447's noun**, never a direct `$.mcp.call('harnu', …)`.

**D8. It is a self-check, never a verification.** The gate never calls `mission_verify_step`,
never sets a proof label and never ticks a check.

## Alternatives considered

| Alternative                                                            | Why not                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read `verify:` from the session's tree (round 1)                       | Fact 3: the model chooses what runs, outside its permissions. Withdrawn.                                                                                                                                                                            |
| Read `verify:` from the committed `HEAD`, refuse when the tree differs | The session can commit, so `HEAD` is the session's too. `origin/<default>` helps only where the default branch is protected, which Harnu cannot know.                                                                                               |
| Hash pin with no disclosure                                            | A pin nobody looked at protects nothing.                                                                                                                                                                                                            |
| The gate inside `harnu-companion`                                      | Fact 5: it would reopen SEC-9 a/b/d for the one mod staged into every session.                                                                                                                                                                      |
| The companion asks the host to run the check                           | Fact 6: no broker exists yet, tranches are shorter than the check, and headless sessions get no ask. It is the cleanest home for SEC-9's intent, and is revisited when P3W1's broker ships (spec Q12). The pin and disclosure carry over unchanged. |
| Main process only                                                      | Fact 1: no outcomes and no caller identity.                                                                                                                                                                                                         |
| Inside T447's `harnu` mod                                              | It is the noun and its guard; a process runner does not belong there.                                                                                                                                                                               |
| `$.process.run` for the check                                          | No abort signal: an interrupted check ran on for up to 300 s, and its result could still be recorded.                                                                                                                                               |
| A `tool.call` rewrite of SendMessage                                   | `session.send` is the event built for it, and covers `$.session.send` too.                                                                                                                                                                          |
| A `tool.call` input rewrite of `message_session`                       | An MCP input rewrite is refused in `auto` mode (T389 P2W5). The gate asks for a re-send instead.                                                                                                                                                    |

## Consequences

- **A repo's `verify:` needs an operator approval before Enforce does anything there.** Until
  then, Enforce degrades to an "unverified" note, plus a "Needs you" item that shows the parts.
- The Mods tab must learn to show the gate:
  - its row, since `planRows` lists only the companion and the skills dir;
  - its permission-deciding role, since `pickPermissionHookers` skips `source: 'harnu'`;
  - a chip for a `session.send` hook;
  - the "with .catch" notes it now reports as unparsed (spec §11.3).
- The per-session mode must be persisted, because `trustFor`'s inputs are app-run memory
  (`src/main/companion/spawn-inject.ts:111-119`, `pty.ts:505-514`). Otherwise a resumed agent
  session would drop to Annotate after a restart.
- `WORKTREE.md` gains a meaning beyond provisioning: what "green" is for the repo. The
  worktree-manifest skill and `docs/user/` must teach the key and what approving it means.
- **Another mod could make the gate run a command of its choosing**, by forging the env or hooking
  `env.get`. That mod can already run any process itself (ADR-0018 D3), so the gate adds nothing to
  it. The Mods tab is the disclosure.
- The gate's value is bounded by its honesty model: it catches a stale "all tests pass", not a
  forged receipt. The verifier never counts the receipt as proof.
