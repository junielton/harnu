# ADR-draft — The verification gate is a separate bundled mod that runs only an operator-approved command

**Status:** proposed (numbered at merge) · **Date:** 2026-10-09 (round 4) · **Card:** T452 ·
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
9. **The approved text runs files the session can edit.** `npm run typecheck` executes the branch's
   `package.json`, tests and configs. `forceDowngradePermission` maps `bypassPermissions` to
   `manual` for MCP children (`src/main/mcp/agent-boot.ts:182-189`), so such a child in `manual` or
   `acceptEdits` writes a script and then claims. A hash over the command text does not change.
10. **The variables that carry the command have more than one source.** `$.env.get` reads the
    process env (TYPES:3580-3598), which a settings file's `env` block feeds at the next spawn,
    resume or park-wake, and which a Bash child and a nested `claude` inherit.
11. **No command exists to run today.** A step carries a verification level (`src/main/mission-core.ts:76-95`).
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
  - Harnu first **deletes any inherited `HARNU_VERIFY_*`** (as `applyCompanionEnv` does for
    `HARNU_SPAWN_TOKEN`, `src/main/companion/spawn-inject.ts:131-141`) and passes the approved
    parts together with `HARNU_VERIFY_ROOT`, the folder they were approved for.
  - The mod never reads the working tree. It checks that the root equals `$.session.root()`, and
    refuses any `HARNU_VERIFY_*` it finds in the `env` block of **any** settings source (`user`,
    `project`, `local`, `flag`, `policy`) or of their merge. A user's Claude Boot args can point
    `--settings` at a file inside the repo, and Harnu never sets these variables through settings,
    so a hit anywhere can only be a plant.
- **Outside Harnu:**
  - The default mode is **annotate**, which runs nothing.
  - `enforce` runs only the `check` option the person set in their own settings.

**D2b. The session's own permission mode decides each run.** Before every part the gate asks
`$.tool.check({ tool: 'Bash', input: { command: part } })`, the same chain a real Bash call goes
through, minus the run. It runs the part only on `allow`. On `ask` or `deny` it hands the run back
("run it yourself"), and the session's own Bash call, governed by its own prompt or rule, becomes
the receipt. So the gate never runs what the session could not. **A query consults the rules and
the mode but runs no classic hook** (TYPES:12883), so a blocking `PreToolUse` hook is not asked
before the gate spawns a part. The gate does not refuse when any such hook exists, because Harnu
installs its own `PreToolUse` `*` hook in every session (`hook-installer.ts:41-50`); the gap is
stated in the user doc and listed for W0 (spec §7.6 a, Q14).

**D3. The gate meets the intent of SEC-4 and SEC-9, not just their letter, and says where it
breaks the letter.**

- **SEC-4's letter is broken knowingly:** the gate reads three literal env names and every
  settings source plus their merge. Its answer to the intent is that **every read can only narrow**: a
  `HARNU_VERIFY_*` key in a settings file or a root that is not the session's removes the parts,
  and nothing in the working tree or cwd is read.
- **Process runs** are limited to approved, disclosed text that the session's own permissions allow,
  never a generic runner.
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

**D4b. A part counts as run only when its exit status is the call's, decided by an allowlist.** A
Bash call has one exit status, the last command's. A call is a receipt only when, after harmless
trailing redirections are removed, it is exactly approved parts and neutral read-only commands
joined by `&&`, with **no other shell metacharacter anywhere** (`&`, `;`, `|`, a newline, `$`, a
backtick, `(`, `)`, `<`, `>`, `{`, `}`, a backslash). Anything else leaves the outcome unknown.
A separate check marks a call as an edit when it may write: a metacharacter that can embed a
command or redirect, or any command, however joined, that is not a part, a narrower run, a directory
change or neutral. Two rounds of patching a separator blocklist were evaded live (round 2: a pipe,
`||`, `;`; round 3: a lone `&` and a newline), so the rule is inverted.

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

| Alternative                                                             | Why not                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read `verify:` from the session's tree (round 1)                        | Fact 3: the model chooses what runs, outside its permissions. Withdrawn.                                                                                                                                                                            |
| Read `verify:` from the committed `HEAD`, refuse when the tree differs  | The session can commit, so `HEAD` is the session's too. `origin/<default>` helps only where the default branch is protected, which Harnu cannot know.                                                                                               |
| Keep patching the list of shell separators                              | Evaded live in two rounds. An allowlist of what a receipt may look like fails closed for every metacharacter, including the ones nobody listed.                                                                                                     |
| Run the approved text without asking the session's permissions          | Fact 9: the model edits a script, the gate runs it with no Bash prompt, and `forceDowngradePermission` is defeated for that run.                                                                                                                    |
| Treat the env as trusted because "the model cannot set the process env" | Fact 10: a settings-file `env` block the model can write, and an inherited env, are two more sources.                                                                                                                                               |
| Hash pin with no disclosure                                             | A pin nobody looked at protects nothing.                                                                                                                                                                                                            |
| The gate inside `harnu-companion`                                       | Fact 5: it would reopen SEC-9 a/b/d for the one mod staged into every session.                                                                                                                                                                      |
| The companion asks the host to run the check                            | Fact 6: no broker exists yet, tranches are shorter than the check, and headless sessions get no ask. It is the cleanest home for SEC-9's intent, and is revisited when P3W1's broker ships (spec Q12). The pin and disclosure carry over unchanged. |
| Main process only                                                       | Fact 1: no outcomes and no caller identity.                                                                                                                                                                                                         |
| Inside T447's `harnu` mod                                               | It is the noun and its guard; a process runner does not belong there.                                                                                                                                                                               |
| `$.process.run` for the check                                           | No abort signal: an interrupted check ran on for up to 300 s, and its result could still be recorded.                                                                                                                                               |
| A `tool.call` rewrite of SendMessage                                    | `session.send` is the event built for it, and covers `$.session.send` too.                                                                                                                                                                          |
| A `tool.call` input rewrite of `message_session`                        | An MCP input rewrite is refused in `auto` mode (T389 P2W5). The gate asks for a re-send instead.                                                                                                                                                    |

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
  `env.get`. That mod can already run any process itself (ADR-0018's third decision point (`## Decision`, :43-45; not sub-decision D3)), so the gate
  adds nothing to it. The Mods tab is the disclosure.
- **A downgraded session that has no allow rule for the check gets a hand-back**, not a run. Its own
  Bash call is the receipt. That costs one prompt in such a session, and it is the point.
- The gate's value is bounded by its honesty model: it catches a stale "all tests pass", not a
  forged receipt. The verifier never counts the receipt as proof.
