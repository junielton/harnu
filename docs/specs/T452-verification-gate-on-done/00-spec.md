# T452 — Verification gate on "done": a claim is done only after its check ran

**Status:** specified (not implemented) · **Date:** 2026-10-09 (round 5) · **Card:** T452 ·
**ADR:** [`ADR-draft.md`](ADR-draft.md) (proposed; numbered at merge)

Files: this spec, [`01-prototype.md`](01-prototype.md) (the prototype hooks module, its tests, and
the real output of `claude plugin validate`, `claude plugin test`, `tsc` and every live run), and
[`ADR-draft.md`](ADR-draft.md) (where the gate lives, where its command comes from, and why the
model cannot choose it).

## 0. Summary

Harnu ships a third mod named **`harnu-verify-gate`**, the first Harnu-staged mod that runs a
process. It watches the claims a session makes that its own work is finished. When the session
wrote code since its last green check, the gate runs the repo's check before the claim goes
through. A red check turns the claim into a refusal that carries the failing output. "Done" then
means the check ran on the tree being claimed.

**The command is the operator's, never the model's.** Harnu reads the `verify:` key of
`WORKTREE.md` from the repo's main checkout with its existing resolver. It shows the command
verbatim, as it already shows `setup`, and passes it to the mod at spawn only when the operator has
approved that exact command (a hash pin), bound to the session's root, after deleting any inherited
value. The mod never reads the working tree, refuses any `HARNU_VERIFY_*` it finds in a settings file,
and runs a part only when **the session's own permission mode would run that command without asking**
(`$.tool.check`, §8.1). The approved text runs the branch's own scripts, which the model can edit, so
the gate must never run what the session could not. Outside Harnu, the mod defaults to annotate and
runs nothing unless the person configured a command themselves (§7).

Seven facts shape the design. Each is cited below and most were shown by a run:

1. **Most executors cannot claim a Mission step.** A session spawned by MCP `create_session` gets
   no Harnu MCP server at all (`src/main/pty.ts:811-819`). It "reports" through native
   `SendMessage`, `git push` and `gh pr create` (ADR-0015:24-38). So the gate covers the claims
   each session shape can actually make (§3, §5), not only `mission_update_step`.
2. **`mission_update_step` cannot be rewritten to "blocked".** Its `set` takes `title` and
   `proof: 'claimed'` only (TC:1464-1480). The "blocked" outcome is a **refusal** with the
   failing output. Once the T447 noun ships, a Mission blocker is raised as well (§9).
3. **The gate runs a command outside Claude's permission system.** So whoever chooses the command
   chooses what runs, even in a session whose permissions Harnu deliberately downgraded (`pty.ts:811-818`).
   The working tree is the session's to edit. Round 1 read `verify:` from it, which let a model
   pick the command (§7.1). Round 2 took the command only from operator-approved state. Round 3
   closes what that left open (§7.6): an approved `npm run typecheck` still runs the branch's
   `package.json`, which the model can edit, so the gate now runs a part only when the session's own
   permissions allow it, and it closes the settings-file and inherited-env routes to the variables.
4. **The Bash hook avoids `tool.call`, out of caution.** A pass-through `tool.call` hook on Bash
   broke `Agent(isolation: "worktree")` on an earlier build (SMOKE:628-650, issue #92533). On
   2.1.296 headless, a later probe found isolation intact (V450), so B4 may already be fixed. The gate uses `tool.check` and
   `classic.PostToolUse` anyway. Both are safe on either evidence, and this shape kept isolation
   intact here too (§4, P4).
5. **The companion may not run processes or call MCP** (T389 SEC-9 a/b, T389/00-master:502).
   The gate has to run a process, so it lives in a separate mod. §10.2 explains how the design
   meets SEC-9's _intent_ rather than stepping around it.
6. **No check command exists anywhere today.** Steps carry a verification _level_ (`MC:76-95`).
   Card ACs carry a `verify:` _kind_ by convention only, with no parser in `src/`. `WORKTREE.md`
   has no such key (`src/main/worktree-manifest.ts:139-148`). D-1 adds it to Harnu's resolver.
7. **A long check fits, and Esc stops it.** A hook's 10 s budget stops while a `$` call is in
   flight (TYPES:5089-5129; SMOKE B1.2 held 15 minutes).
   - A 290 s check delivered its deny (R3).
   - A 400 s check was killed at the 300 s timeout (R4; again on round-3 code, R9).
   - Esc killed a running check within a second and recorded nothing (R5; again on round-3 code, R10).

   The gate runs the check with `$.process.spawn`, whose child dies with the claim's dispatch
   (TYPES:3516-3553). It does not use `$.process.run`, which takes no abort signal.

The gate is a **self-check by the authoring session**. It never verifies a step, never changes a
proof label and never replaces the delivery-verifier (§9).

## 1. Origin and scope

**Origin.** Ideas 44 and 68 of the operator's ideation report (`.harnu/out/claude-code-mods-ideas.md`
in the main checkout, gitignored). They belong to the "Done gates / verification" cluster with 38,
55, 63 and 67:

- Idea 44, "Verification gate on 'done' (executor self-check)": "When the executor says a step is
  done (`mcp.call(mission_update_step status:done)` from inside), the mod runs the step's `verify`
  command via `process.run` first; if it fails, the call is rewritten to `blocked` with the stderr
  tail attached". Three of its premises are false on this build:
  - the verb has no `status` field;
  - no step carries a `verify` command;
  - a rewrite to `blocked` has no target field.

  §5 and §7 replace each one.

- Idea 68, "Verification receipt before 'done'": "On `turn.complete`, if the reply text claims
  completion … but no Bash test/typecheck/build ran since the last edit, inject a notice and redraw
  the response row with a '⚠ unverified' badge." It uses `$.model.classify`, which exists: one
  completion on the engine's small fast model that answers one of the given labels
  (TYPES:2638-2656). v1 uses a fixed word list instead (§5.1 row 9). The list costs no request,
  answers the same way every time, and keeps the `model` chip off the Mods tab. Using `classify` to
  cut false positives is Q10.

The report ranks the pair fifth of its "Ten I would build first": "Rewrites the executor's own
'step done' into 'blocked' when the step's verify command fails. Done means the check ran."

**Goals.**

- G1. A session that edited files cannot make a gated claim on a tree whose check is red, or whose
  check never ran after the last edit, without the claim being refused or flagged.
- G2. The judgement uses the session's **own** tool-call log (what it edited, what it ran). The
  model's words are not evidence.
- G3. A green run the session already made counts as the receipt, part by part. The gate runs only
  the parts no run covers.
- G4. **The model cannot choose, change or widen what the gate runs.**
- G5. Whatever the gate learns is visible to a verifier and the operator as a hint, never as proof.
- G6. Nothing breaks when the gate is absent, off, fails, or runs outside Harnu.

**Non-goals.**

- N1. Grading acceptance criteria. That is the delivery-verifier's job (§9).
- N2. Recording a `verified` proof or calling `mission_verify_step`. The gate never does either.
- N3. Gating the operator. A claim the operator makes in the UI never passes through a session.
- N4. Catching a model that **forges a receipt** or claims through a path the gate does not see
  (§12 K1). The gate catches the honest mistake, the stale "all tests pass". That is the common one.
  N4 is about _evading_ the gate. It never covers the gate being turned into a way to run code.
  G4 is a hard requirement.
- N5. Per-AC commands. v1 runs one repo-wide check of ordered parts. Per-AC and per-step commands
  are open (Q3).

## 2. Conventions

| Prefix            | Means                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TYPES:n`         | `types/claude-code.d.ts` written by Claude Code **2.1.295**'s `plugin-authoring` skill on 2026-10-09 (21,463 lines). The `claude` that ran every probe reported `2.1.296 (Claude Code)`. Types are regenerated per build, so W0 re-reads every cite.                                                                                                                                                                                                                                                                  |
| `REF:n`           | The `reference.md` beside those types (215 lines).                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `TC:n`            | `src/main/mcp/tool-catalog.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `TH:n`            | `src/main/mcp/tool-handlers.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `MC:n`            | `src/main/mission-core.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `WM:n` / `WI:n`   | `src/main/worktree-manifest.ts` / `src/main/worktree-ipc.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `MA:n`            | `src/main/mods-audit-core.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `T389/<file>:n`   | `docs/specs/T389-companion-mod/<file>`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `T447/<file>:n`   | `docs/specs/T447-harnu-sdk-noun/<file>`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `SMOKE:n`         | `docs/studies/T389-smoke-evidence.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `DV:n`            | `resources/skills/skills/delivery-verifier/SKILL.md`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `P-K`, `R1`…`R17` | Runs recorded in [`01-prototype.md`](01-prototype.md): `P-K` the current kit suite; `R1`…`R5` live on round-2 code; `R6`…`R10` live on round-3 code; `R11`…`R13` live on round-4 code; `R14`…`R16` live on round-5 code; `R17` live after the redirect fix.                                                                                                                                                                                                                                                           |
| `P1`…`P6`         | Live runs of the round-1 prototype, kept in `01-prototype.md` for the mechanisms round 2 did not change (the `tool.check` deny, the ledger's classic hooks, worktree isolation).                                                                                                                                                                                                                                                                                                                                      |
| `V-*`             | Runs by other sessions: `V-45` (a 45 s check), `V-A2` and `V-A3` (the round-1 verifier); `V-R2a`, `V-R2b` and `V-R2c` (the round-2 verifier: the piped-check bug, an Esc kill, an `fs.read` mutation); `V-R3` (the round-3 verifier: the lone-`&` and newline evasions, and the `$.tool.check` hook gap); `V-R4` (the round-4 verifier: the `cd sub` receipt, the "narrower" writes and the broad neutral list); `V450` (the T450 verifier's B4 re-run). All are summarised in `01-prototype.md` §"Independent runs". |

"Author" means a session whose own ledger (§6) holds at least one edit. "Claim" means one of the
signals in §5. "Check" means the ordered list of command **parts** §7 resolves.

## 3. Who can claim "done", by session shape

| Shape                        | Harnu MCP?                                                                                                         | How it says "done" today                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Operator's own session       | yes (`pty.ts:820-824`, app-managed `--mcp-config` first)                                                           | any verb: `mission_update_step`, `move_card`, `mission_request_close`, `message_session`; Bash `gh pr …`; its reply |
| Board / manifest dispatch    | yes. `spawnedBy: 'agent'`, not `agentControlled` (`src/renderer/src/stores/sessions.ts:3135-3139`, ADR-0015:33-37) | the same verbs; `gh pr create`; its reply                                                                           |
| MCP `create_session` child   | **no**. `agentControlled: true` (`sessions.ts:3229-3231`) withholds the server (`pty.ts:811-819`)                  | `git push`, `gh pr create`, a `SendMessage` report to its owner (ADR-0015:24-32), its reply                         |
| Scheduler tick (`claude -p`) | observe: read verbs only, no Bash, no Edit. act: full toolset (`docs/harnu-features.md`, Scheduler)                | observe: none. act: like an operator session, unattended                                                            |

Two consequences:

- The pitch's target, an executor calling `mission_update_step`, exists only for the first two
  shapes. The third is the shape `orchestrate-delivery` dispatches. Its claims are `gh pr create`,
  `SendMessage` and its reply.
- `mission_update_step` calls the claim "the owner's 'I believe this is done, unverified'"
  (TC:1466). An orchestrator claiming **on behalf of** a child edited nothing, so its ledger is
  empty and rule A lets the claim through (§5.2). Gating that claim on the child's receipt is Q4.

## 4. The engine contract the gate relies on (C-1)

| Mechanism                                             | What the gate needs from it                                                                                                                                                                                                                                                                                                                                                                                                 | Cite                                                               | Shown by                                          |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------- |
| `tool.call` deny on an MCP tool                       | `{ deny: reason }` in place of `next` refuses the call; the model reads the reason as an error result                                                                                                                                                                                                                                                                                                                       | TYPES:3942-3955, :12701-12711                                      | P-K; R2 red (the server never saw the call)       |
| `tool.call` result `context`                          | A note the model reads after the result, "as a PostToolUse hook's is"                                                                                                                                                                                                                                                                                                                                                       | TYPES:12728-12736                                                  | P-K; R2 green                                     |
| List matcher on the MCP verbs                         | `{ tool: ['mcp__harnu__…', 'mcp__capy__…'] }` is a one-of; literal strings, so no `opaque` chip                                                                                                                                                                                                                                                                                                                             | TYPES:5842-5850                                                    | P-K (validate lists both names)                   |
| `tool.check` deny                                     | Runs before the tool; `{ decision: 'deny', reason }` refuses it; a real call carries `tool_use_id`, a query does not. It holds in **every** permission mode, `bypassPermissions` included                                                                                                                                                                                                                                   | TYPES:3956-3969, :12812-12870; SMOKE:476-487 (B1.6)                | R1, R3; P1; V-45 (bypass); P-K                    |
| `tool.check` and `classic.*` on Bash are safe         | They leave `Agent(isolation: "worktree")` intact. A Bash `tool.call` broke it on an earlier build (B4); V450 found it intact on 2.1.296 headless, so B4 **may already be fixed** there (§0 fact 4)                                                                                                                                                                                                                          | SMOKE:628-650 (B4); V450                                           | P4 (with a no-mod control)                        |
| `classic.PostToolUse` / `…Failure`                    | The finished call's `tool_name`, `tool_input`, `tool_response`, or `error`. A non-zero Bash exit arrives as `PostToolUseFailure`; a subagent's calls reach the parent's hooks                                                                                                                                                                                                                                               | TYPES:7851-7876                                                    | P1; V-A2; V-A3; P-K                               |
| `classic.SessionStart`                                | `source: 'startup' \| 'resume' \| 'clear' \| 'compact' \| 'fork'`                                                                                                                                                                                                                                                                                                                                                           | TYPES:11643-11648                                                  | P-K                                               |
| `session.send`                                        | Fires for every plain-text message leaving the session, from the SendMessage tool or `$.session.send`; `next({ ...e, text })` rewrites what is sent "with no new approval"                                                                                                                                                                                                                                                  | TYPES:4360-4371, :11553-11640 (the quote :11563-11566), :2872-2884 | P-K                                               |
| `turn.complete`                                       | `{ text }` returned with a different text is shown beneath the answer; the transcript is never rewritten; `e.agentId` marks a subagent's turn                                                                                                                                                                                                                                                                               | TYPES:4456-4464, :13280-13351                                      | P-K                                               |
| `$.process.spawn`                                     | argv (no shell of its own), `cwd`, `env`; **the loop is the child's life**: leaving it, `return()`, `next.signal` aborting or a module unload kills the child                                                                                                                                                                                                                                                               | TYPES:3516-3553, :8086-8125                                        | R3, R4 (timeout kill), R5 (Esc kill)              |
| `$.clock.after`                                       | A timer whose callback calls `return()` on the stream: the gate's own timeout                                                                                                                                                                                                                                                                                                                                               | TYPES:3454, :12626                                                 | R4; P-K                                           |
| Hook budget                                           | 10 s of the hook's **own** time; the clock stops while a `$` call is in flight, except `$.clock` waits; `.catch` grace 1 s                                                                                                                                                                                                                                                                                                  | TYPES:5089-5129, REF:154; SMOKE:418-432 (B1.2, 15 min)             | R3 (290 s); V-45                                  |
| `next.signal` on Esc                                  | Aborts the dispatch at once (SMOKE B1.4: "the in-flight fetch is torn down")                                                                                                                                                                                                                                                                                                                                                | REF:154-157; SMOKE:447-457                                         | R5                                                |
| `.catch` fail-open                                    | A hook that throws is skipped and the chain goes on, unless `.catch` answers                                                                                                                                                                                                                                                                                                                                                | TYPES:3931-3940, REF:78-79                                         | P-K (validate lists every gate "with .catch")     |
| `$.state` ledger                                      | Per session, held by the host, kept across a hot reload; `atom`/`read`/`update` write with `ifVersion` and retry                                                                                                                                                                                                                                                                                                            | REF:118, TYPES:14692-14735                                         | P-K; R1                                           |
| `$.env.get`                                           | A literal name; resolves the process env Harnu set at spawn. That env can also be fed by a settings file's `env` block, which is why §7.6 reads the settings                                                                                                                                                                                                                                                                | TYPES:3580-3598                                                    | R1-R10; P-K (`mock.env`)                          |
| `$.ui.status`                                         | A status-line text while the check runs: SMOKE B1.3 shows only a spinner during a `tool.check` hold                                                                                                                                                                                                                                                                                                                         | TYPES:2477; SMOKE:434-445                                          | R5 (the line showed and cleared)                  |
| Validate: `$` only to top-level functions             | `$` passed to a closure fails validation                                                                                                                                                                                                                                                                                                                                                                                    | `docs/dev/companion-mod.md:48-61`                                  | P-K (round 1's first validate failed on it)       |
| Kit                                                   | `$.tool.call`, `$.tool.check` (a **query**: `ToolCheckArgs` = `tool` + `input`, TYPES:12796), `$.classic.*`, `$.session.send`, `$.turn.complete`, `mock.env`, `mock.clock`, `test(name, { options })`                                                                                                                                                                                                                       | TYPES:15440-15490, :15900-15957                                    | P-K                                               |
| `$.tool.check` (a call)                               | The session's own permission verdict for a command, without running it: "a plugin's call runs the same chain with the calling hook alone skipped". The gate asks it before every part it would run (§8.1). **It runs no classic hook** (`hook?` is "absent on a `$.tool.check` query"), so a blocking `PreToolUse` hook is not consulted (§7.6 a)                                                                           | TYPES:4698-4709, :12796, :12883                                    | R7 (`ask` → handed back); R6, R9 (allow); P-K     |
| `$.settings.read({ source })` and `$.settings.read()` | One settings source as loaded (`user`, `project`, `local`, `flag`, `policy`) or the merge; the gate looks for `HARNU_VERIFY_*` in each `env` block, and in the merge, in case one block shadows another (§7.6 b)                                                                                                                                                                                                            | TYPES:3562-3578, :11799-11816                                      | R8; P-K (every source, and the merge)             |
| `$.ui.notice`                                         | **Not used**: it shows a line under an open permission dialog only, and a dispatched executor has none                                                                                                                                                                                                                                                                                                                      | TYPES:2334-2347                                                    | argued                                            |
| `$.fs.read`                                           | **Not used** any more. It reads "relative to the working directory" (TYPES:3230); round 1 read `WORKTREE.md` with it, which was the flaw §7.1 removes. **The proof is validate's `calls:` line, which lists no `$.fs`** (P-K). The kit records every `fs.read` and the trust test asserts none; a recording guard is the honest form, because the engine skips a hook that throws, so a throwing guard alone proves nothing | TYPES:3223-3242                                                    | P-K (validate `calls:`; `fsReads` asserted empty) |

## 5. The "done" signals (U-1)

### 5.1 Every way a session claims completion, and what the gate does

"Intercepted" means the gate judges the claim (§5.2). "Deny" refuses it. "Annotate" lets it through
with a note. "Pass" means untouched.

| #   | Signal                                                                                                     | Who can raise it (§3)                                    | Hook                                                   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `mcp__harnu__mission_update_step` with `set.proof === 'claimed'`                                           | operator session, board dispatch                         | `tool.call`, `{ tool: [mcp__harnu__…, mcp__capy__…] }` | **Intercepted. Deny** on red or unrunnable. **Annotate** on green (the receipt), on stale in annotate mode, and when there is no check. A title-only `set` passes.                                                                                                                                                                                                                                                            |
| 2   | `mcp__harnu__move_card` with `to: 'review'`                                                                | operator session, board dispatch                         | `tool.call`, same shape                                | **Intercepted**, as row 1. `backlog`/`ready` pass. `done` is not a value the verb takes (TC:961, `roadmap-core.ts:744`).                                                                                                                                                                                                                                                                                                      |
| 3   | `mcp__harnu__mission_request_close`                                                                        | owner session                                            | `tool.call` (W1)                                       | **Annotate only**, when this session is an author with no green check after its last edit. The server already refuses unless the fixed end is `verified` by a non-builder (TC:1637-1655, MC:704-734).                                                                                                                                                                                                                         |
| 4   | `mcp__harnu__mission_verify_step` with `met` or `needs-human`, from an author                              | operator session, board dispatch                         | `tool.call` (W1)                                       | **Deny** when this author's own check is red. Otherwise **annotate** that a verification by an author lands `self-verified` unless the step's session links name someone else (TH:4455-4466). Never changes the verdict or the label.                                                                                                                                                                                         |
| 5   | Bash `gh pr create` (not `--draft`/`-d`) and `gh pr ready`                                                 | every shape with Bash                                    | **`tool.check`** on Bash (§0 fact 4)                   | **Intercepted. Deny** on red or unrunnable. On green or no check the engine's verdict stands (Q6 adds a note). A query (no `tool_use_id`) never runs a check: it judges from the ledger alone.                                                                                                                                                                                                                                |
| 6   | Bash `git push`                                                                                            | every shape with Bash                                    | none                                                   | **Pass.** A push is not a claim, and it is how work survives a crash.                                                                                                                                                                                                                                                                                                                                                         |
| 7   | A plain-text message leaving the session that reads as a completion report (SendMessage, `$.session.send`) | every shape; the only claim channel of an MCP-less child | **`session.send`**                                     | **Annotate by rewrite**: one receipt line appended to `text` (green, stale, red or no check). Never denied, because a red report is exactly what an orchestrator needs. `session.send` is the event built for this: it covers both routes and rewrites `text` "with no new approval" (TYPES:4360-4371). A `tool.call` rewrite of SendMessage's input would cover only the tool, and that shape was never probed (V-45 notes). |
| 8   | The T447 noun's `harnu.missionStepClaim` and `harnu.cardMove { to: 'review' }`, raised by another mod      | any session with the `harnu` mod loaded                  | a hook on the noun's event (W3)                        | **Intercepted** after T447 ships, as rows 1-2, answering the noun's refusal shape `{ ok: false, error: 'REFUSED' }` (T447/01-contract:53-86, :197-204).                                                                                                                                                                                                                                                                       |
| 9   | The main loop's reply (`turn.complete`) matching the completion word list                                  | every shape                                              | `turn.complete`                                        | **Annotate**: a line beneath the answer when no green check covers the last edit. The transcript is never rewritten (TYPES:4456-4464).                                                                                                                                                                                                                                                                                        |
| 10  | A direct `$.mcp.call('harnu', 'mission_update_step', …)` from another mod                                  | any mod                                                  | none in v1                                             | **Not intercepted.** T447's guard denies every direct call into `harnu` from any mod but its own (T447/03-security:50-56). Until then it is a known gap (§12 K2).                                                                                                                                                                                                                                                             |
| 11  | `.harnu/REPORT.md`, a commit message, a PR body saying "done"                                              | every shape                                              | none                                                   | **Pass.** Prose. Rows 5 and 7 cover the moments it accompanies.                                                                                                                                                                                                                                                                                                                                                               |
| 12  | `mcp__harnu__message_session` whose `message` reads as a completion report: the MCP twin of row 7          | operator session, board dispatch                         | `tool.call`, `{ tool: [mcp__harnu__…, mcp__capy__…] }` | **Deny-and-resend**: when the message lacks a `[verify-gate]` line, the gate refuses once with "send it again with this line appended, as written", followed by the line. The model's next call carries it and passes. The gate does not rewrite the input, because an input rewrite on an MCP tool gets the call denied in `auto` mode (T389/P2W5:93, :110-118).                                                             |

The card's U-1 named rows 1-5 and 9. Rows 6-8 and 10-12 were added because they are the claims the
most common executor shape actually makes (§3), the MCP twin the round-1 grading named, or the ways
around the gate.

### 5.2 The judgement

One function decides every intercepted claim, from the ledger (§6) and the policy (§7: mode and
parts):

| Rule | When                                                                                                                                                | Verdict       | Gate answer                                                                                                          |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------- |
| A    | The ledger holds no edit                                                                                                                            | `not-author`  | pass untouched                                                                                                       |
| B    | Every part has a run newer than the last edit, all green                                                                                            | `green`       | pass with a receipt naming who ran the last part                                                                     |
| C    | Some part has a run newer than the last edit that was red                                                                                           | `red`         | **deny**, naming the part, who ran it, and the tail; nothing re-runs                                                 |
| D    | No part is configured (Harnu passed none, or the person configured none)                                                                            | `no-check`    | pass with "no operator-approved verify command" (inside Harnu) or "no check is configured" (outside)                 |
| E    | Some part is not covered, and the mode is `annotate`, or this is a `tool.check` query, or a report (rows 7, 12)                                     | `stale`       | pass with "no green run since the last edit (…). Run `<part>`, …"                                                    |
| F    | Some part is not covered, the mode is `enforce`, and this is a real claim: the gate runs the missing parts in order, stopping at the first red (§8) | `green`/`red` | as B or C, the run recorded `by: 'gate'`                                                                             |
| G    | A part could not run (the session's permissions would ask or refuse, §8.1) or could not finish (timeout, spawn failure)                             | `unrun`       | **deny**: "the gate could not run `<part>` (…). Run it yourself with Bash; a green run after your last edit counts." |
| H    | The claim's dispatch was aborted (Esc) while a part ran                                                                                             | `aborted`     | nothing: the child is killed, nothing is recorded, and the engine has already abandoned the claim (§8.3)             |

Every deny reason starts with `[verify-gate]` and names:

- the claim;
- the part;
- **who ran it**: "run by the gate" or "run by this session". Round 1 omitted this, and in V-45 the
  model answered "a check that I did not run in this session";
- what to do next;
- at most 40 lines or 3,000 characters of output (§8.4).

## 6. "Ran since the last edit", against the session's own log (U-3)

### 6.1 The ledger

The gate keeps one value per session in `$.state` (`harnu-verify-gate.ledger`):

```ts
type Ledger = { seq: number; lastEditSeq: number; lastEdit: string; runs: Record<string, CheckRun> }
type CheckRun = {
  part: string
  seq: number
  ok: boolean
  by: 'session' | 'gate'
  at: number
  tail: string
}
```

Every observed tool call increments `seq`. An edit sets `lastEditSeq = seq`. A run sets
`runs[part].seq = seq`. A part "ran since the last edit" when `runs[part].seq > lastEditSeq`. The
order comes from a counter, not from clock time.

### 6.2 What counts as an edit, a run of a part, or neither

The ledger is fed by `classic.PostToolUse` (the call ran) and `classic.PostToolUseFailure` (it
failed). Each carries the call's `tool_input` and, in `BaseHookInput`, `cwd` (TYPES:826-829).

**The governing rule: the classifier fails safe in one direction.**

> Calling a call an **edit** costs the gate one re-run of the check, which is always safe. Calling
> it a **receipt** can wave a red tree through, which never is. So a receipt needs certainty, and
> anything the classifier is unsure about is an edit.

Four rounds each found a new hole of the same kind by patching a list: round 2 a pipe, `||` and
`;`; round 3 a lone `&` and a newline; round 4 a `cd` into a subdirectory, "narrower" runs that
write (`npx vitest run -u`, `npm run lint -- --fix`) and "neutral" commands that write
(`gh pr checkout`, `git diff --output=f`, `git commit`, `rg --pre`). Each patch widened a list of
things the classifier trusted. Round 5 changes the direction: **the classifier trusts only an exact
allowlist, and everything else is an edit.** Every rule below follows from the governing rule.

`classifyBash` first excises the **complete** harmless redirections, `2>&1`, `>&2` and `>/dev/null`
(each must end at whitespace or the end of the command, and each leaves a space behind), then
decides. The whole-token rule matters: bash reads `>&2h` as "both streams to the file `2h`", so a
prefix match would strip `>&2` and fuse `h` onto the command. `echo payload >&2h2` would then clean
to `echo payloadh2` and pass as neutral, and a decoy `sh check.s >&2h` would clean to the approved
`sh check.sh` and pass as a receipt. With whole tokens only, `>&2h`, `2>&1x` and `>/dev/nullx`
keep their `>`, which rule 2 reads as an edit.

1. **A lone `cd`, `pushd` or `popd`** (nothing joined to it) is **neutral**: it writes nothing, and
   what runs after it is judged by the hook's `cwd`, below.
2. **Any metacharacter that can embed a command, redirect or hide a separator** (a backtick, `$`,
   `(`, `)`, `<`, `>`, `{`, `}`, a backslash) is an **edit**.
3. **Any command, however it is joined** (the command is split at every `&`, `;`, `|` and newline),
   that is **not an approved part and not on the neutral allowlist** is an **edit**. There is no
   "narrower run" category: a part followed by arguments is an unknown command, and `-u` and
   `--fix` may write. So is `cd` inside a chain, and every command not listed below.
4. **A part that ran anywhere but the approved root is an edit.** `classic.PostToolUse` carries the
   `cwd` the call ran in. The Bash tool's working directory persists between calls, so `cd sub`
   followed by `sh check.sh` runs the **subdirectory's** check, which says nothing about the root
   (a monorepo does this in good faith). A part counts only when `cwd` equals `$.session.root()`
   (trailing slashes ignored). **An unknown or empty `cwd` is not the root.**
5. **A receipt** is a call that passed 1-4 and is, besides, **exactly approved parts and neutral
   commands joined by `&&`, with no other metacharacter**: `&`, `;`, `|`, `||` and a newline are all
   excluded. With `&&` a failure stops the chain, so the call's exit status is the failing part's.
6. **Anything else that passed 1-4 is neutral**: unknown outcome, no receipt, no edit. Every command
   in it is provably non-writing (a neutral shape, or a part whose outcome is unknown, such as
   `sh check.sh 2>&1 | tail -5`).

| Finished call                                    | Counts as                                                                               |
| ------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `Edit`, `Write`, `NotebookEdit`, succeeded       | an edit (`lastEdit = "<tool> <path>"`)                                                  |
| the same, failed                                 | nothing                                                                                 |
| rule 5, in the root                              | a run of each part it names: green on `PostToolUse`, red on `PostToolUseFailure` (V-A2) |
| rule 5 with `tool_response.backgroundTaskId` set | nothing: a background run reports before it finishes                                    |
| rule 6                                           | **nothing**                                                                             |
| rules 1-4 say edit                               | **an edit**                                                                             |

**The neutral allowlist.** These are the only commands that are not an edit besides a part. Each is
a command plus the argument shapes that cannot write a file, switch the tree or run a program. An
argument is a plain word (a path, a ref, a number or a quoted string without a metacharacter), a
short flag cluster such as `-sb`, or one of the long options named here.

| Command                           | Allowed arguments                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pwd`                             | none                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `ls`                              | short flags, words                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `cat`                             | one or more words                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `head`, `tail`, `wc`              | short flags, words                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `echo`                            | short flags, words                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `grep`, `rg`                      | short flags, words. **No long option**, so no `rg --pre`, `--pre-glob` or `grep --exclude-from`                                                                                                                                                                                                                                                                                                                                                 |
| `git status`                      | `-s`, `-b`, `-sb`, `--short`, `--branch`, `--porcelain[=v1\|v2]`, `--`, words                                                                                                                                                                                                                                                                                                                                                                   |
| `git diff`, `git log`, `git show` | short flags, words, and `--stat`, `--shortstat`, `--numstat`, `--name-only`, `--name-status`, `--compact-summary`, `--cached`, `--staged`, `--check`, `--oneline`, `--graph`, `--decorate`, `--abbrev-commit`, `--no-color`, `--no-merges`, `--no-ext-diff`, `--no-textconv`, `--unified=N`, `--max-count=N`, `--pretty=(oneline\|short\|medium)`, `--date=(short\|iso\|relative)`, `--`. **Not** `--output`, `--ext-diff` or anything unlisted |
| `git rev-parse`                   | `--short`, `--abbrev-ref`, `--show-toplevel`, `--git-dir`, `--verify`, `--is-inside-work-tree`, words                                                                                                                                                                                                                                                                                                                                           |
| `git rev-list`                    | `--count`, `--oneline`, `--no-merges`, `--max-count=N`, words                                                                                                                                                                                                                                                                                                                                                                                   |
| `git branch`                      | `--show-current`, `--list`, `-a`, `-r`, `-v`, `-vv`, `--all`, `--remotes`, words (**listing only**: no `-D`, no creation without a flag is parsed as a list)                                                                                                                                                                                                                                                                                    |
| `gh pr`, `gh issue`               | `view`, `list`, `status`, `checks`, `diff`, with flags and words. **Not** `checkout`, `create`, `ready`, `merge`, `edit`, `close`                                                                                                                                                                                                                                                                                                               |
| `gh run`                          | `list`, `view`, with flags and words                                                                                                                                                                                                                                                                                                                                                                                                            |

Deliberately **not** on it, so each is an **edit**: `git commit` (it runs pre-commit hooks such as
lint-staged and `prettier --write`), `git add`, `git push` (pre-push hooks), `git fetch`,
`git checkout`, `git stash`, `git branch -D`, `gh pr create` and `gh pr ready` (they may push),
`cat > f`, `echo x > f`, `tee`, `touch`, `rm`, `sed -i`, `make`, `npm install`, `node …`. The honest
flow "run the check, `git commit`, `gh pr create`" therefore costs one extra run of the check at
claim time: the commit may have rewritten files, and the gate does not know it did not.

`git diff`, `git log`, `git show` and `git status` can run a program that **repository or user
configuration** names, not an argument the model writes in the call: a **textconv** driver
(`.gitattributes` and `.git/config`), `diff.external`, `core.fsmonitor` (which `git status` and
`git diff` start to watch the tree) and the **pager**. They are a residual, named here and not
closed. The calls do not widen them: they run the same programs a plain `git status` would.

So the parts count **one by one**:

- `npm run typecheck` then `npx vitest run > /dev/null 2>&1`, as two Bash calls, is a full receipt
  (P-K). The honest habit `npx vitest run 2>&1 | tail -40` is **not** (the pipe makes it rule 6),
  so the gate runs the part itself, once.
- If the session ran only `npm run typecheck`, the gate runs only `npx vitest run` (P-K).
- The joined form `npm run typecheck && npx vitest run` counts for both parts. On failure both are
  marked red, because the gate cannot tell which part failed.
- `git status && sh check.sh 2>&1 && git diff --stat > /dev/null` is a receipt: neutral commands join
  the chain (P-K).
- A part joined to a narrower run of itself, or a focused run on its own, is an **edit** (rule 3).
- `cd sub` then `sh check.sh`, and `cd sub && sh check.sh`, are never a receipt for the root:
  rule 4 for the first, rule 3 (a `cd` inside a chain) for the second.

Other choices:

- **Subagents count.** A subagent's `Write` reached the parent's ledger and staled a receipt
  (V-A3). A subagent in an isolated worktree runs in another `cwd`, so its part runs are edits.
- **Equality, not "contains".** A command must equal a part. `echo npm run typecheck` is another
  command, and an `echo` of that text is not a run.
- **Kit tests, with tables.** 171 tests, all passing:
  - one row per metacharacter (19 rows, two tests each);
  - the verifier's evasions from rounds 2-4 and the honest shapes;
  - the `cwd` rule: `cd sub` then the part, an unknown `cwd`, a trailing slash, `cd` in a chain;
  - five "narrower" runs that write (`--fix`, `-u`, `vitest run -u`, `lint -- --fix`, a focused
    run);
  - six **lookalike redirections** (`>&2h`, `>&2h2`, `2>&1x`, `>/dev/nullx`, `>>/dev/nullx`,
    `2>/dev/nulls`), each as a receipt attempt and as a write that must be an edit, the decoy
    `sh check.s >&2h`, and six whole-token redirections that must still be receipts;
  - **31 commands that must be an edit** (including each one named in the grading: `gh pr
checkout`, `git diff/show/log --output`, `git diff --ext-diff`, `git commit`, `rg --pre`) and
    **23 read-only commands that must not stale a receipt**.
- **Negative controls.** The 152-test file of the previous round run against the round-4
  classifier passed 124 and **failed 28**, one for each hole then open. The 171-test file run
  against the round-5 classifier passes 164 and **fails 7**: the six `echo payload <lookalike>`
  rows and the decoy. Against the current one all 171 pass (P-K).
- **Live** (R14-R17): a receipt cannot come from `sub`, a narrower `--fix` run stales the tree, and
  `git diff --output=out.txt` stales it (`01-prototype.md`).

### 6.3 Lifetime: reload, compaction, resume, clear

| Event                      | Ledger                                                                                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hot reload of the mod      | Kept: `$.state` is the host's (REF:118).                                                                                                                                                                            |
| Compaction                 | Kept: same process.                                                                                                                                                                                                 |
| `--resume` (a new process) | **Assumed lost (A4).** On `classic.SessionStart` with `source: 'resume'` the gate seeds `lastEditSeq` with "(edits before resume are unknown)", so the first claim checks (P-K). Failing closed here costs one run. |
| `/clear`                   | Same seeding (`source: 'clear'`).                                                                                                                                                                                   |

## 7. Where the check comes from, and why the model cannot choose it (U-2, U-3)

### 7.1 The round-1 flaw

Round 1 read `verify:` with `$.fs.read('WORKTREE.md')` from the session's own tree, falling back to
a userConfig option. In `enforce` it ran the value through `sh -c` inside `tool.check`. Three
things were wrong with that:

- **The session can edit both files.** `WORKTREE.md` and `WORKTREE.local.md` sit in the tree the
  session works in, and an MCP child in `acceptEdits` writes them without asking.
- **The run happens outside Claude's permission system.** That defeats `forceDowngradePermission`,
  which Harnu applies to MCP children precisely so they cannot run what they like
  (`pty.ts:811-818`).
- **It is a two-step code-execution path.** A prompt-injected agent sets
  `verify: node -e "…"`, then runs `gh pr create`, and the gate executes the payload.

A dispatch into a worktree of an untrusted branch (a fork's PR) gets the same path with no injection
at all. A substring denylist does not help.

"Same trust as `setup`" was also false. Harnu reads `setup` from `repoRoot`
(`readManifestSources`, WI:339-350), discloses it verbatim before an MCP `create_worktree` (WI:470-477,
`previewWorktreeCommands` WI:1063; `DisclosedWorktreeCommands`, WM:613-625, "the RCE surface"), and
runs it once, at creation. Round 1's `verify` was undisclosed, ran repeatedly, came from the
session's tree, and outside Harnu defaulted to `enforce`.

### 7.2 Decision: the operator approves the exact command; Harnu passes it at spawn

| Step                          | Inside Harnu                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Where the key lives        | `verify:` in `WORKTREE.md` front matter: one string, or a list of **parts** run in order. Each part is a POSIX command line (ADR-0005). The overlays (`WORKTREE.local.md`, `.claude/worktree.md`) and the `worktree-manifest.md` alias apply exactly as for the other keys.                                                                                                                                                                                                                                               |
| 2. Who reads it               | **Harnu's main process**, with the existing resolver over `readManifestSources(repoRoot)`: the repo's **main checkout**, never the session's worktree. There is one reader, so the gate and `create_worktree` can never disagree. The resolver also normalises BOM and CRLF (WM:178), which round 1's ad-hoc parser did not.                                                                                                                                                                                              |
| 3. What the operator sees     | The parts, verbatim, with their SHA256 over the canonical JSON list, in a "Needs you" item and in the folder's Startup dialog: "Harnu will run these commands to check a claim of done in this repo." The same disclosure posture as `DisclosedWorktreeCommands`.                                                                                                                                                                                                                                                         |
| 4. What the operator approves | The **hash**, once per repo (`<userData>/verify-gate/approvals.json`, `{ repoRoot → { hash, parts, approvedAt } }`). There is no verb for it, so an agent cannot approve.                                                                                                                                                                                                                                                                                                                                                 |
| 5. What the session gets      | **First Harnu deletes any inherited `HARNU_VERIFY_*`** from the env it is about to hand over, exactly as `applyCompanionEnv` deletes `HARNU_SPAWN_TOKEN` (`src/main/companion/spawn-inject.ts:131-141`). Then, when the current hash equals the approved one: `HARNU_VERIFY_GATE=<mode>`, `HARNU_VERIFY_CMD=<the approved parts as JSON>` and `HARNU_VERIFY_ROOT=<the session's folder>`. When the hash differs: only `HARNU_VERIFY_GATE=<mode>`. The gate then answers rule D and a "Needs you" item asks to re-approve. |
| 6. What the mod reads         | `HARNU_VERIFY_GATE`, `HARNU_VERIFY_CMD` and `HARNU_VERIFY_ROOT` (`$.env.get`, literal names), and the `env` block of all five settings sources and their merge (§7.6). It checks that the root equals `$.session.root()` and that no settings file names a `HARNU_VERIFY_*` key. **It never reads the working tree**: validate's `calls:` line lists no `$.fs`, and the kit's `fsReads` is asserted empty (R1 shows a model-edited `WORKTREE.md` changing nothing).                                                       |

Outside Harnu (no `HARNU_VERIFY_GATE` in the env):

- The default mode is **`annotate`**, which never runs anything.
- `enforce` runs only the `check` userConfig option. That option lives in the person's own settings
  (`pluginConfigs`), not in any repo, and is set by them through `/config`.
- `WORKTREE.md` is never read there either.

What this buys, and its limits:

- **G4 holds against the model, in three layers**:
  1. _The text._ A changed command has a new hash, which no operator approved, so nothing runs.
  2. _The env._ The model cannot set the claude process's own env (a Bash `export` reaches only
     that Bash child), and §7.6 closes the settings-file route to it.
  3. _What the text runs._ The approved text runs the branch's own scripts, which the model can
     edit. §7.6 and §8.1 make the session's own permission mode decide each run.
- **A fork's PR is covered.** The command comes from the main checkout and the operator's pin, never
  from the branch.
- **It is not a boundary against another mod.** A mod can `$.env.set` the variable (TYPES:3609) or
  hook `env.get`. A mod can also run any process itself. Mods of one tier are not isolated
  (ADR-0018's third decision point (`## Decision`, :43-45; not sub-decision D3)), and that is disclosed in the Mods tab, not solved here.
- **The approval is per repo, not per worktree.** An approved command runs in every session of that
  repo, which is the intent. Changing it means a new approval. A session's folder maps to its
  repo's main checkout the way `create_worktree` maps it: `resolveRepoRoot` runs `git rev-parse
--git-common-dir` from the folder (WI:306-320, `worktree-ipc.ts`), so a linked worktree and the
  main checkout share one approval record. A folder with no git repo gets no approval and rule D.

### 7.3 D-1: the server change, in full

`src/main/worktree-manifest.ts`:

- `verify` added to `KNOWN_KEYS` (WM:139-148).
- `verify?: string[]` on `PartialManifest` (WM:113-122).
- A `verify` branch in `normalizeRecord` (WM:259-300), using `asStringArray` and accepting a single
  string as a one-part list.
- `verify` merged by `mergeManifest` (WM:375) with the overlay-replaces-base rule `setup` uses.
- `verify: string[]` on `ResolvedManifest`.

`src/main/worktree-ipc.ts`: nothing new to read. `readManifestSources` (WI:339-350) already reads
`WORKTREE.md`, the `worktree-manifest.md` alias, `WORKTREE.local.md` and `.claude/worktree.md`
from `repoRoot`.

Plus:

- A pure `verifyHash(parts)` beside the resolver.
- The approval store and the spawn-env injection (W2).
- The worktree-manifest skill learns to author the key.
- This repo's own `WORKTREE.md` gains `verify: [npm run typecheck, npx vitest run]` (its prose
  already calls `npm run typecheck` "the go/no-go signal", `WORKTREE.md:31-34`).

### 7.4 What else was considered for the source

| Candidate                                                                | Why not                                                                                                                                                                                |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mission step `verification`                                              | A level (`existence \| verifier \| human`, MC:76-95, schema 205-226), not a command. No step or mission field holds one.                                                               |
| Card AC `— verify: test\|visual\|manual\|review`                         | A kind, by skill convention only (`orchestrate-delivery/SKILL.md:114`); nothing in `src/` parses it (`card-detail.ts:138` reads `{ text, checked }`). Useful later as a filter (§7.5). |
| Read `verify` from the committed `HEAD` and refuse when the tree differs | Better than round 1, but the session can commit, so `HEAD` is the session's too. Reading `origin/<default>` helps only where the default branch is protected, which Harnu cannot know. |
| Hash pin without disclosure                                              | A pin nobody looked at protects nothing. The disclosure is what makes the approval mean something.                                                                                     |
| `package.json` scripts                                                   | Only by guessing.                                                                                                                                                                      |
| A new Mission field                                                      | The most common executor shape cannot read its mission (§3). Possible later, per step (Q3).                                                                                            |

### 7.5 Which claims a check applies to

v1 applies the one approved check to every gated claim. In W3, AC kinds become a filter, through
T447's `boardGet` (T447/01-contract:188). A card whose ACs are all `visual`, `manual` or `review`
gets rule D's note rather than a check that proves nothing about it.

### 7.6 The three routes round 2 left open

Round 2 closed "the model writes the command". The round-2 grading found three ways to still
make the gate run something the operator did not mean. The first two are about what the approved
text executes, the third and fourth about the variables that carry it.

**a) The approved text runs code the model wrote.** The operator approves `npm run typecheck` and
`npx vitest run`. In the session's worktree those execute the branch's `package.json` scripts,
test files and configs, which the model can edit. `forceDowngradePermission` turns
`bypassPermissions` into `manual` (`src/main/mcp/agent-boot.ts:182-189`), so an MCP child in manual
or `acceptEdits` mode can write `"typecheck": "node -e …"` and then claim, and the gate would run it
with no Bash prompt. A fork as the main checkout has the same problem in the other direction. A hash
over the command text cannot see this, because the text did not change.

**The fix is to let the session's own permission mode decide.** Before each part the gate asks
`$.tool.check({ tool: 'Bash', input: { command: part } })` (TYPES:4698-4709), which is the same
chain a real Bash call goes through, minus the run. It runs the part only on `allow`. On `ask` or
`deny` it answers rule G: "the gate could not run `<part>` (this session's permissions would ask
before running it). Run it yourself with Bash." The session's own run, which goes through the real
prompt or allow-rule, then becomes the receipt. A live run shows the hand-back (R7).

What this changes in practice:

- A session that may already run `npm run typecheck` (an allow rule, or a mode that allows it) gets
  the gate's run. It was going to run that code itself.
- A downgraded child with no such rule gets a hand-back, and its own Bash call is what the
  operator's permission settings govern.
- The mode and rules are the **operator's** (or Harnu's downgrade), not the model's. A model that
  edits `.claude/settings.local.json` to add an allow rule is a separate problem. That Claude Code
  protects its own settings files from a session in `acceptEdits` is **argued here, not shown**:
  no run in this spec tries it, and W0 probes it (A10). The gate does not widen it either way: it
  only ever asks what the session may already do.

**What the query does not consult** (found by the round-3 verifier, TYPES:12883). A
`$.tool.check` query "runs no classic hook". So a settings `PreToolUse` hook that would **block** a
command (a security hook, a repo policy) is **not** asked before the gate spawns the part, although
it would be for the model's own Bash call. Two cases follow:

- **A blocking `PreToolUse` hook.** The gate can run a part such a hook would have refused. The
  part is the operator-approved text and the session's rules allowed it, so this is a narrower
  gap than round 2's, but it is real. The gate does **not** refuse when a `PreToolUse` hook exists:
  Harnu installs its own `PreToolUse` `*` hook in every session it spawns, for state detection
  (`src/main/hook-installer.ts:41-50`), so a blanket refusal would turn the gate off everywhere
  inside Harnu. Q14 asks whether to match hook commands, and A9 lists it for W0.
- **The auto-mode classifier.** A query answers what the rules and the mode say, and an `ask`
  stays an `ask`: the classifier settles it only on a real call. So the gate never runs a part on
  the classifier's say-so. It hands back (rule G), and the session's own call goes to the
  classifier. Whether a query's `allow` can differ from the real call's verdict in `auto` is A9.

**b) The env can be forged through project settings.** `$.env.get` reads the process env
(TYPES:3580-3598), and a settings file's `env` block feeds that env at the next spawn, resume or
park-wake. `.claude/settings.local.json` in the worktree is a file the model can write, so it could
plant `HARNU_VERIFY_CMD`. The gate therefore reads `$.settings.read({ source })` for **all five
sources**, `user`, `project`, `local`, `flag` and `policy`, **and the merge** (TYPES:3562-3578,
:11799-11816), and **treats any `HARNU_VERIFY_*` key in an `env` block, from any of them, as rule
D** ("no operator-approved verify command applies here (HARNU_VERIFY_* is set
in the local settings)"). R8 shows it with a planted `.claude/settings.local.json`. `flag` and `policy` are read too, although the operator or an administrator owns them. `flag` is
what `--settings` and the SDK's inline settings carry, and a user's Claude Boot args can point
`--settings` at a file **inside the repo**, which the model can write. Harnu never sets
`HARNU_VERIFY_*` through any settings source, so a hit from any of them can only be a plant. The
merge is read as well, because the types say the merge "takes a key from the last source that has
it" (TYPES:3568-3569). If that is per top-level key, one source's `env` block could shadow
another's, so a per-source read alone might miss a plant that the engine then applies. The kit
tests a hit in each source and one visible only in the merge. This **replaces §10.2's
earlier claim that only another mod can forge the env**. A settings file the session can write is a
second route, and W0 probes whether the engine really feeds a settings `env` block into
`$.env.get` at resume (A8).

**c) Inherited env.** Bash children see `HARNU_VERIFY_*`. A nested `claude` that has the gate
installed (a person who ran W4's switch) would inherit repo A's approved parts and run them in repo
B's cwd. Two defences, both required:

- Harnu **deletes** any inherited `HARNU_VERIFY_*` before it injects its own, as `applyCompanionEnv`
  does for `HARNU_SPAWN_TOKEN` (`spawn-inject.ts:131-141`). A spawn Harnu does not govern then
  carries nothing.
- The values are **bound to a root**. `HARNU_VERIFY_ROOT` is the folder they were approved for, and
  the mod runs nothing unless it equals `$.session.root()`. The kit shows a mismatch setting the
  parts aside (P-K).

## 8. Running it safely (U-3)

### 8.1 What runs, and where

- **Only approved parts** (§7.2), one at a time, in order. Each runs as `['sh', '-c', part]`
  through `$.process.spawn`, which has no shell of its own (TYPES:3516-3553).
- **Only parts the session's own permissions would run.** Before each part the gate calls
  `$.tool.check({ tool: 'Bash', input: { command: part } })` and runs it on `allow` only. On `ask`
  or `deny` it hands the run back (rule G), and the session's own Bash call, governed by its own
  prompt or rule, becomes the receipt (§7.6 a; R7). Without this, an approved
  `npm run typecheck` would execute a `package.json` the model edited, outside every permission the
  session has.
- **Working directory:** `$.session.root()`, the session's project root, which for a Harnu
  worktree session is the worktree. A shell `cd` does not move it (TYPES:2776-2783).
- **Environment:** the session's, plus `CI=1`, so test runners take their non-interactive path.
  Standard input is closed from the start, because `input` is absent (TYPES:8098-8104), so a prompt
  in the check fails fast instead of hanging.
- **No denylist.** Round 1's substring denylist is removed. The guards are that the operator saw
  and approved the exact text (§7.2) and that the session's own permissions allow its run
  (above), not a list of bad words.
- **Concurrency:** one run per session at a time. W1 keeps the in-flight run in a module variable
  keyed by `lastEditSeq`, so two racing claims share it.
- **The person sees it.** A status line reads `verify-gate: running <part>` while a part runs, and
  is cleared after (R5 shows both). Without it a `tool.check` hold shows only the spinner
  (SMOKE B1.3).

### 8.2 Timeouts, measured and run

The gate's default is **300 s per part**, configurable up to 600 (the userConfig `timeoutSeconds`
outside Harnu; W2 adds a per-repo field in the same approval record). `$.process.spawn` has no
timeout of its own (TYPES:8086-8107). The gate sets one with `$.clock.after(ms, …)` calling
`return()` on the stream, which kills the child (TYPES:3520-3522).

**Measured on this machine** on 2026-10-09 (20 cores, this worktree at `cb7fb58`, warm caches,
`/usr/bin/time -f %e`):

| Command             | Wall time | Exit                                                                                                                            |
| ------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck` | 14.93 s   | 0                                                                                                                               |
| `npx vitest run`    | 38.42 s   | 1: 630 files, 12,515 tests; one failure in `tests/usage-poller.test.ts` ("probes are never injected"), untouched by this branch |

This repo's two parts take about 53 s here. 300 s per part leaves about 20× headroom for the
typecheck and 7.8× for the suite.

**Run live** (01-prototype):

| Run             | Check                               | Result                                                                           |
| --------------- | ----------------------------------- | -------------------------------------------------------------------------------- |
| P3 (round 1)    | 15 s                                | deny delivered                                                                   |
| V-45 (verifier) | 45 s                                | deny delivered, 67 s wall                                                        |
| **R3**          | **290 s**                           | deny delivered with the tail, 307 s wall                                         |
| **R4**          | **400 s against the 300 s default** | refused as `unrun` at the timeout, 317 s wall; `pgrep` found no `sleep 400` left |

**SMOKE B1.1's 30 s cap does not apply.** B1.1 is a cap on a single `$.http.fetch` ("no complete
answer within 30000ms", SMOKE:399-416; `HttpInit` has no timeout option). `$.process.spawn` is
pulled piece by piece, so each pull is its own `$` call, and B1.2 held a hook for 15 minutes across
many calls (SMOKE:418-432). R3 and R4 confirm this for the gate's own shape. **600 s is still
unrun**, and so is 300 s inside a real Harnu session. Both are W0 checks.

### 8.3 Esc, and what an interrupted check leaves

The claim waits for the check, so the person may press Esc. The engine aborts the claim's dispatch
and `next.signal` fires (SMOKE B1.4). Because the run is a `$.process.spawn` loop, that abort
**kills the child** (TYPES:3520-3522). The gate then:

- returns verdict H, `aborted`: no deny text, because nobody waits for one;
- **records nothing**, so a half-run check is neither a receipt nor a red mark;
- clears its status line.

R5 shows this in an interactive session under tmux. The gate's `sleep 117` child was gone within
1 s of Esc. A second `gh pr ready` started the check again, which proves nothing was recorded, and
a second Esc killed it again.

Round 1's `$.process.run` could not do this. Its init is `cwd`, `env`, `stdin`, `timeoutMs`
(TYPES:7999-8018), with no signal, so an interrupted check ran on for up to 300 s and its result
could still be recorded.

### 8.4 Output capture and truncation

The gate keeps the last 64,000 characters while streaming, then a **tail**: the last 40 lines,
then the last 3,000 characters of those. The tail goes into the deny reason, the ledger and (W3)
the `mission_log` note, which allows 8,000 characters (TC:1524).

### 8.5 When nothing is runnable

| Situation                                                                              | Result                                                                                                       |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| No `verify:` key in the repo                                                           | Rule D: pass, "no operator-approved verify command applies here; this claim is unverified".                  |
| A `verify:` key the operator has not approved, or changed since                        | Rule D, plus a "Needs you" item to approve the shown parts.                                                  |
| `HARNU_VERIFY_*` found in a settings file, or the parts' root is another folder (§7.6) | Rule D, naming the reason in parentheses.                                                                    |
| The claimed card's ACs are only `visual`/`manual`/`review` (W3)                        | Rule D's note, naming the kinds.                                                                             |
| Outside Harnu, no `check` configured                                                   | Rule D: "no check is configured".                                                                            |
| The session's permissions would ask about, or refuse, a part                           | Rule G: deny, "run it yourself"; the session's own Bash run, under its own permissions, becomes the receipt. |
| A part cannot start, or outlives its timeout                                           | Rule G, same wording.                                                                                        |

## 9. Relation to independent verification (U-4)

### 9.1 What the gate is, and is not

The gate is a **self-check** by the session that wrote the code, judged from that session's own
log. It answers one question: did the repo's approved check run green on this tree after the last
edit?

- It never calls `mission_verify_step`, so it never produces a `verified` or `self-verified` proof.
  T447 left that verb out of its noun for the same reason (T447/03-security:28).
- It never ticks a check, never moves a card to `done` (no verb can, TC:961), never raises a close.
- The delivery-verifier still grades every AC from evidence, blind to the executor's report
  (DV:17-22, 45-62). It still records with `mission_verify_step` from a session that built none of
  the steps (DV:224-233, TH:4455-4466).

### 9.2 How it complements the verifier

The verifier's deterministic table already checks "Tests ran after the last edit | test-run
timestamp vs. last commit time | a 'lucky pass'" (DV:70-79). The gate moves that check to the
moment of the claim, inside the session, where the edit log is exact. A claim that reaches the
verifier has passed one green run. The verifier spends its time on what only it can judge.

The receipt is a **hint, never proof**: "An executor's own tick is recorded as `by: executor` and
never counted" (DV:202-203). A verifier may skip its own run only when the receipt's HEAD sha equals
the PR head (W3 adds the sha). Otherwise it runs the repo's gate command itself.

### 9.3 What it records, and where

| Where                       | What                                                                                                                                                                                                                                                     | When                                                                                               |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| The claim's own result      | The deny reason or the `context` note                                                                                                                                                                                                                    | W1, every intercepted claim                                                                        |
| A report to another session | The receipt line appended by `session.send` (row 7), or carried after a resend (row 12). It reaches the orchestrator, which records what it needs with `mission_log` (ADR-0015:24-32)                                                                    | W1 (prototype covers it)                                                                           |
| The Mission Log             | `mission_log({ missionId, stepId, note })`, note = `verify-gate · green\|red\|unverified · <part> · HEAD <sha7> · by session\|gate` and, when red, the tail. A fixed format a verifier can grep                                                          | W3, through T447's `$.harnu.missionLog` (T447/01-contract:205-209), when the claim named a mission |
| The step's blockers         | On red, `missionBlockerSet` with `stepId`, `owner: 'agent'`, `reason: 'verify-gate: <part> failed after the last edit'` and `unblocks: 'a green run of <part> after the last edit'`. On the next green claim, `missionBlockerClear` with the same reason | W3, same channel: the "blocked state" the card asks for, as a flag (TC:1533)                       |

W3 waits for T447 because T447's guard will deny every direct `$.mcp.call` into `harnu` from any mod
but `harnu` itself (T447/03-security:50-56). The noun also scopes mission writes to the caller's own
steps (T447/03-security:23). Before T447, or where the noun answers `NO_MCP`, the gate still denies
and annotates. It just writes nothing into the Mission.

## 10. Packaging and the companion's rules (C-3)

### 10.1 Decision

**A separate mod, `harnu-verify-gate`, bundled by Harnu and staged like the companion.** Harnu's
main process owns the preference, the `verify:` key, the operator's approval and the spawn env. The
mod owns detection, the run of approved parts, and the answer.
[`ADR-draft.md`](ADR-draft.md) records it.

| Option                                                      | Verdict                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inside `harnu-companion` (`resources/companion/`)           | **Rejected.** It needs `$.process.spawn` (SEC-9a) and a Bash hook, and W3 needs Mission writes. These are enforced statically (`scripts/ci/api-surface-scan.mjs:133-175`, `tests/companion/api-surface.test.ts:96-119`). The companion's `tool.call` surface is closed (MOD-3, T389/00-master:524), and P2W5 owns its MCP matcher.                    |
| Companion asks the host to run the check (a new `ask` kind) | **Rejected for v1.** No ask kind is registered (`src/main/companion/host-core.ts:113, :498` have no caller; `server.ts:563-564` answers `FEATURE_DISABLED`). Ask tranches are ≤20 s (MOD-5) against a ~53 s check. MOD-5 forbids an ask in a non-interactive session. It is the strongest alternative for SEC-9's intent (§10.2), and is kept as Q12. |
| Main process only (no mod)                                  | **Rejected.** Main sees every tool-call **attempt** through its `PreToolUse` `*` hook (`src/main/hook-installer.ts:41-50`), but not the **outcome**. It installs no `PostToolUse` (:39), so it cannot tell a red run from a green one. The MCP transport has no per-session identity (TC:1312).                                                       |
| Inside T447's `harnu` mod                                   | **Rejected.** That mod is the noun and its guard.                                                                                                                                                                                                                                                                                                     |
| **A separate bundled mod**                                  | **Chosen**, under §10.2's conditions.                                                                                                                                                                                                                                                                                                                 |

### 10.2 SEC-4 and SEC-9: meeting the intent, not stepping around it

The gate is the **first** Harnu-staged mod that runs a process: the companion runs none (SEC-9a). A
separate mod is not exempt from the reasons behind the companion's floor just because the floor's
static test only scans the companion. Each rule's intent, and how the gate meets it:

| Rule                                                                                                                                                          | Its intent                                                                     | How the gate meets it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SEC-4: "Nothing security-relevant is read from env, cwd or project files; the single exception is the literal `HARNU_SPAWN_TOKEN` nonce" (T389/00-master:497) | A value the session can influence must never steer a security decision         | **The gate breaks the letter of SEC-4 and says so.** It reads three literal env names (`HARNU_VERIFY_GATE`, `HARNU_VERIFY_CMD`, `HARNU_VERIFY_ROOT`) and the `env` block of every settings source and their merge. **Its answer to the intent is that each read can only narrow what runs, never widen it:** (1) the working tree and cwd are never read (validate's `calls:` lists no `$.fs`); (2) a `HARNU_VERIFY_*` key found in a settings file _removes_ the parts (§7.6 b) instead of supplying them; (3) a root that is not the session's folder removes them; (4) what survives is the operator-approved hash text, and still runs only when the session's own permissions allow it (§7.6 a). The model cannot change the claude process's env (a Bash `export` reaches only that Bash child); a settings file it can write is closed by (2). Another mod can `$.env.set` the variable (TYPES:3609) or hook `env.get`. That mod can already run any process itself, so the gate gives it nothing new. It is the same exposure SEC-4 accepts for the token (ADR-0018's third decision point (`## Decision`, :43-45; not sub-decision D3)), and the Mods tab is where it is disclosed. |
| SEC-9a: no `$.process.run`/`spawn` in the companion                                                                                                           | No generic "run this" in a mod staged into every session                       | The gate runs only operator-approved, disclosed text (§7.2), and only when the session's own permissions would run it (§7.6 a). It takes no input from the model, a card, a Mission field or the host channel, and exposes a "run" to no one. That is the difference between a check and a generic runner.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| SEC-9b: no `$.mcp.call` in the companion                                                                                                                      | No mod-side write path into Harnu that bypasses the server's audit and scoping | The gate makes no `$.mcp.call`. W3's writes go through T447's noun, which carries the scoping and the audit.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| SEC-9d: no Bash `tool.call` matcher                                                                                                                           | Do not break worktree subagents (#92533)                                       | None. The gate uses `tool.check` and classic hooks (§0 fact 4).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

The same static test the companion has (`api-surface-scan.mjs`) gets a gate profile in W1: allowed
hooks and calls equal the gate's `api-surface.json`, with no `fs.*`, no `http.*`, no `mcp.call`, no
Bash `tool.call`, `process.spawn` called only from `runPart`, and `runPart` reached only after
`permitted()`.

### 10.3 Staging and who gets it

Staging works like the companion's (ADR-0018 D1, `src/main/companion/staging-core.ts:14, :77-86`): an
immutable versioned copy under `<userData>/verify-gate/<modVersion>/harnu-verify-gate/`, passed as
one more `--plugin-dir` after the companion's, inside `withOptionArgs` (`pty.ts:855-857`). Every
PTY session Harnu spawns gets it, except:

- **Scheduler ticks.** Observe ticks are never authors. Act ticks are Q5. Staging by per-spawn
  `--plugin-dir`, not by process env, keeps the gate out, though T447 found ticks inherit Harnu's
  process-env `CLAUDE_CODE_PLUGIN_DIRS` (T447 card, round 3).
- **T245 read-only review companions** (`pty.ts:790-810`).

**Outside Harnu**, the mod is a plain plugin, installed with
`/plugin install harnu-verify-gate --marketplace <owner>/<repo>` or an "Also outside Harnu" switch
like P4W3's (`src/main/companion/external-install-core.ts:6, :13`). There it defaults to
**annotate** and never runs anything unless the person sets `mode: enforce` and a `check` (§7.2).

## 11. Control and failure (C-4)

### 11.1 Switches and defaults

| Switch                                                                                                                  | Values                                     | Default                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------- |
| Settings → General → Integrations, "Verify before done", global, beside the "Harnu mod" switch (`CHANGELOG.md:160-163`) | Off · Annotate · Enforce                   | **Enforce** for sessions Harnu spawns for an agent; **Annotate** for the operator's own |
| Folder context menu, "Verify before done"                                                                               | Inherit · Off · Annotate · Enforce         | Inherit                                                                                 |
| The repo's `verify:` approval ("Needs you", Startup dialog)                                                             | approve the shown parts · leave unapproved | unapproved: Enforce degrades to rule D until approved                                   |
| Outside Harnu: the mod's userConfig                                                                                     | `mode`, `check`, `timeoutSeconds`          | `annotate`, empty, 300                                                                  |

**Which sessions are "for an agent", and making that durable.** Harnu's own classification is
`trustFor` (`src/main/companion/spawn-inject.ts:111-119`): `readOnly` → `read-only`;
`agentControlled` or `spawnedBy === 'agent'` → `agent`; otherwise `operator`. Its inputs are not
durable:

- `spawnedBy` lives in `RENDERER_ONLY_SESSION_KEYS` (`sessions.ts:4310`), never in the transcript.
- In main it lives in `sessionSpawnOrigins`, an app-run-scoped map (`pty.ts:505-514`).

After a Harnu restart, a resumed agent session would fall to `operator` and so to **Annotate**.
W2 fixes this:

- At first spawn, Harnu writes the resolved mode beside the session id in
  `<userData>/verify-gate/sessions.json`.
- A respawn or resume reads it before `trustFor`.
- An entry is dropped when its transcript is deleted.
- **The key moves when the id moves.** The store is keyed by session id, and a session's id changes
  twice: a synthetic id becomes the real one once the transcript lands, and a fork gets a new id.
  Harnu already re-keys its in-memory ledgers at that moment (`rekeySession`,
  `src/main/pty.ts:1150-1160`, where `sessionSpawnOrigins` is moved from `fromKey` to `toKey`).
  W2 moves the `sessions.json` entry in the same function, and a test asserts it for both
  transitions. A resume with an unchanged id needs no move.

A session with no entry, one started before W2 shipped, gets the folder default for an operator
session. That is stated in the user doc, not hidden.

**Mode applies to the next spawn.** The mod reads the env once per call, but the env is fixed at
spawn, so a running session keeps its mode (Q7). The approved parts follow the same rule: a repo
re-approved mid-session reaches only sessions spawned afterwards.

### 11.2 Failure: fail-open, through `.catch`, with four verdict exceptions

Every hook is registered with `.catch(($, e, next) => next(e))` (P-K's validate lists each one
"with `.catch`"). A gate that throws or overruns lets the claim through, as if absent
(TYPES:3931-3940, REF:79). A broken gate must not wedge an unattended executor, and independent
verification still runs downstream.

These are verdicts, not failures:

1. **Red** (C/F) denies.
2. **Unrunnable** (G) denies; the session can settle it itself.
3. **Resume/clear** seeds the ledger as edited (§6.3).
4. **Aborted** (H) records nothing.

A failed hook is visible: a dim transcript line while the session hot-reloads, and a debug-log
line in every session (REF:78-81). W1 counts failures in the ledger for Q8.

### 11.3 What Settings → Mods shows, and what it must learn (W2)

Chips come from `deriveCapabilities` (MA:369-393), fed by `claude plugin validate`'s notes. For the
round-2 prototype (P-K):

| Chip          | Why it lights                                 | Rule   |
| ------------- | --------------------------------------------- | ------ |
| `process`     | `$.process.spawn` (via `runPart`)             | MA:376 |
| `tool-calls`  | hooks `tool.call` (the MCP verbs)             | MA:381 |
| `permissions` | hooks `tool.check` (Bash)                     | MA:382 |
| `env`         | reads `HARNU_VERIFY_GATE`, `HARNU_VERIFY_CMD` | MA:388 |

`files` no longer lights: round 2 reads no file. `mcp`, `other-mods`, `gate`, `prompts`, `model`,
`terminal` and `opaque` stay off.

**Three Mods-tab gaps W2 must close:**

1. **The tab would not show the gate at all.** `planRows` lists only the companion (`source:
'harnu'`) and the bundled skills dir (MA:553-595). W2 adds the staged gate as a second
   `source: 'harnu'` row, with `PlanInput.harnuGateDir`.
   `pickPermissionHookers` excludes `source: 'harnu'` (MA:752-762). That is right for the
   companion, which never alters a verdict (`resources/companion/hooks/register.ts:1243`). It is
   wrong for the gate, which denies. W2 narrows the exclusion to the companion's row key.
2. **`session.send` has no chip.** The gate rewrites outgoing messages (row 7). No capability rule
   reads a `session.send` _hook_ (`submit` reads only _calls_, MA:383). W2 adds `session.send` to
   a chip: "can rewrite messages to other sessions". That changes `design.md` and both i18n
   locales.
3. **`.catch` notes land as unparsed.** Validate prints "gating hook with .catch: …".
   `GATING_NOTE_RE` matches only "without .catch" (MA:233-245), and `NOTE_RE` matches neither
   (MA:162-163). So every gate line is reported unparsed. W2 parses both forms as facts.

## 12. Risks

| Id  | Risk                                                                                                                   | Severity                                   | Handling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| K0  | **The gate becomes a way to run code the model chose**                                                                 | High                                       | Round 2 called this "closed by design"; the round-2 grading showed it was not. Three routes remained and are now closed (§7.6): the approved text runs a `package.json` the model edited (the session's own permissions now decide each run, R7); a settings file plants `HARNU_VERIFY_*` (refused, R8); inherited env runs repo A's parts in repo B (deleted at spawn, bound to a root). The command text itself is operator-approved by hash (§7.2, R1). What stays open: a model that can already widen its own permission rules, which the gate does not widen (§7.6 a); a `PreToolUse` hook that would block a part but is not consulted by a `$.tool.check` query (§7.6 a, Q14); and another mod forging the env (§10.2). |
| K1  | A model forges a receipt or claims through an unhooked path                                                            | Medium                                     | Non-goal N4. Segment equality defeats `echo <part>` (§6.2). The verifier never counts a receipt as proof (§9.2).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| K2  | Another mod calls `mission_update_step` directly before T447 ships                                                     | Low                                        | §5.1 row 10; closed by T447's guard.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| K3  | The edit rule is too eager: a harmless command counts as an edit, so the gate runs the check once more                 | Low                                        | By design (§6.2): an edit costs a re-run and a wrong receipt costs a red tree. The allowlist grows with evidence, never by default.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| K4  | A tree-changing command is trusted: it reached the neutral allowlist, or a flag turns a read-only command into a write | Medium                                     | The allowlist is exact commands plus enumerated flags with no long options by default (§6.2). The programs git configuration can start (textconv, `diff.external`, `core.fsmonitor`, the pager) are a named residual. Every fuzz row asserts the opposite direction.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| K5  | A slow suite makes every claim wait                                                                                    | Low                                        | Once per edit cycle; parts the session already ran are skipped; Esc kills it (R5); rule G hands it back.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| K6  | #92533's status changes again                                                                                          | Low                                        | The gate never registers `tool.call` on Bash. W0 records the result either way (§13).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| K7  | A later build changes classic-event routing (V-A2, V-A3)                                                               | Medium                                     | W0 re-runs both. A CLI ceiling in the gate's `api-surface.json` forces annotate above the tested build.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| K8  | The operator approves a command without reading it                                                                     | Medium                                     | The disclosure shows the parts verbatim, and an approval is per repo and per hash. Any change asks again. This is the same posture as `create_worktree`'s confirm.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| K9  | A failing check is recorded as green, or a red tree is waved through by a stale receipt                                | **High** (found live in rounds 2, 3 and 4) | The governing rule (§6.2): fail safe in one direction. A receipt only when certain (exactly parts and neutral commands joined by `&&`, no other metacharacter, run in the approved root), an edit whenever unsure. Exact neutral allowlist, no "narrower" category, `cwd` rule. Fuzz and allowlist tables and a negative control (P-K); live R14-R16.                                                                                                                                                                                                                                                                                                                                                                           |
| K10 | The gate's mode silently drops to Annotate after a Harnu restart or an id change                                       | Medium                                     | §11.1: a persisted per-session record, re-keyed with the session (`rekeySession`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

## 13. Implementation outline (C-6)

S ≈ ≤ 1 day, M ≈ 2-3 days, L ≈ a week.

| Wave | Size | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Depends on                              |
| ---- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| W0   | S    | Spike on the pinned CLI: A1, A4, A5, A7, A8, A9, A10, **A11** (§15) live; 300 s and 600 s parts inside a real Harnu session; re-read the regenerated types for every cite in §4. **#92533 check:** re-run SMOKE B4's shape (pass-through Bash `tool.call`, `isolation: "worktree"`) interactively and in a tick, `rtk` off. If isolation holds everywhere, the `tool.check` + classic shape **stays**: it works either way, and moving back buys nothing. Record the result in SMOKE and relax SEC-9d only by a separate ADR. | —                                       |
| D-1  | S    | §7.3 in full: `KNOWN_KEYS`, `PartialManifest`, `normalizeRecord`, `mergeManifest`, `ResolvedManifest`, `verifyHash`, tests (including the alias, the overlays and CRLF). The worktree-manifest skill authors the key. This repo's `WORKTREE.md` gains it.                                                                                                                                                                                                                                                                     | —                                       |
| W1   | M    | The mod: the round-3 prototype plus rows 3-4, single-flight, its `api-surface.json`, a CLI ceiling, the static profile of §10.2 (no `fs.*`, `http.*`, `mcp.call`, Bash `tool.call`, `process.spawn` only after `permitted()`), and `mod-step.mjs` coverage.                                                                                                                                                                                                                                                                   | W0, D-1                                 |
| W2   | L    | Host side: staging and `--plugin-dir`; **the approval store, its disclosure UI ("Needs you" item, Startup dialog) and the env injection**; the global and per-folder switch; **deleting inherited `HARNU_VERIFY_*` and injecting `HARNU_VERIFY_ROOT` (§7.6 c)**; the durable per-session mode **re-keyed with the session id (§11.1)**; the three Mods-tab fixes (§11.3).                                                                                                                                                     | W1                                      |
| W3   | M    | Mission writes through T447's noun: `dependencies: ['harnu']`, the `mission_log` receipt with the HEAD sha, the step blocker, row 8, the AC-kind filter.                                                                                                                                                                                                                                                                                                                                                                      | W1, T447 (noun waves, D-A child lookup) |
| W4   | S    | "Also outside Harnu" switch and marketplace entry, like P4W3.                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | W2                                      |

**Contracts the implementation owes:**

- **`CHANGELOG.md`**: W1-W4 each add a dated entry.
- **`docs/harnu-features.md` + marker bump** (W2): the session learns that its claims are gated,
  what a `[verify-gate]` refusal means, how to clear it (run the parts, then claim), that a red
  result is reported, not hidden, and the resend rule of row 12. W3 adds the receipt format and
  the blocker.
- **`docs/user/`** (W2): what the gate does, the modes and defaults, **how to approve a repo's
  `verify:` and what approving means**, the Mods-tab chips. W4 covers outside Harnu.
- **`design.md` + both i18n locales** (W2): the switch, the approval item and dialog section, and
  the new Mods-tab chip.
- **ADR**: this unit's `ADR-draft.md`, numbered at merge.

## 14. Relation to T389 and T447 (C-2)

Status checked against the code on 2026-10-09 (`git log` at `cb7fb58`).

| Work                                          | Status (code)                                                                                              | Relation                                                                                                                                                             |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T389 P1W1-P1W6, P2W1 (shadow), P4W1 A+B, P4W3 | **Shipped** (commit `7446534`; `CHANGELOG.md:151-182`)                                                     | **Builds on** staging (P1W2), the CLI ceiling (P1W2), prefs (P1W4), the Mods tab (P4W1, which W2 must extend, §11.3), and the outside-Harnu switch (P4W3).           |
| T389 P2W4, live contract and in-process guard | Specified, **not implemented** (`src/main/orchestrator-guard.ts:46-47` still enforces through `guard.mjs`) | Overlaps as a **pattern**, with the same fail-open posture (T389/P2W4:263-283). An orchestrator is never an author.                                                  |
| T389 P2W5, MCP caller attribution             | Specified, **not implemented**                                                                             | Overlaps on the **matcher**. The gate never rewrites MCP input (row 12's deny-and-resend exists because of P2W5's auto-mode finding), so the two can share the tool. |
| T389 P3W1, P3W2                               | Specified, **not implemented** (`resources/companion/hooks/register.ts:1246, :1273`)                       | P3W2 is the precedent for a `tool.check` deny (T389/P3W2:45-56, :204-237). P3W1's permission dialogs are untouched.                                                  |
| T389 SEC-4, SEC-9                             | Rules of the companion                                                                                     | The gate meets their **intent** (§10.2).                                                                                                                             |
| T389 P4W2, P4W5                               | Specified, **not implemented**                                                                             | No overlap in v1 (Q9).                                                                                                                                               |
| T447 `$.harnu` noun                           | **Spec merged** (PR #41, `9142876`); **noun not implemented**                                              | **W3 depends on it.** No direct `$.mcp.call('harnu', …)`.                                                                                                            |
| Ideas 38, 55, 63, 67                          | Ideas only                                                                                                 | 38 and 63 are the independent side (§9). 67 reuses the ledger.                                                                                                       |

The card text said T447 was "PR #41, not merged". It merged as `9142876`; the noun is unbuilt.

## 15. Assumptions for the W0 spike

| Id  | Assumption                                                                                                                                                                                                                                                                | Status                                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | `tool.call` deny and `context` on `mcp__harnu__*` work in a live **Harnu** session                                                                                                                                                                                        | Shown live against a stand-in server (R2, P5, P6). Left: Harnu's server and "Ask before agent actions".                                                                                                                                                   |
| A2  | A non-zero Bash exit raises `classic.PostToolUseFailure`                                                                                                                                                                                                                  | **Shown** (V-A2).                                                                                                                                                                                                                                         |
| A3  | Classic tool events fire for a subagent's calls, into the parent's ledger                                                                                                                                                                                                 | **Shown** (V-A3).                                                                                                                                                                                                                                         |
| A4  | `$.state` does not survive `--resume`                                                                                                                                                                                                                                     | Open. The seeding is safe either way: if state does survive, the seed is skipped (`lastEditSeq > 0`).                                                                                                                                                     |
| A5  | `turn.complete`'s note shows in the terminal and the desktop surface                                                                                                                                                                                                      | Open.                                                                                                                                                                                                                                                     |
| A6  | `$.process.spawn`'s child dies on Esc and on the timer's `return()`                                                                                                                                                                                                       | **Shown** (R5, R4; again on round-3 code, R9, R10).                                                                                                                                                                                                       |
| A7  | `session.send` rewrites the text the receiver reads, for SendMessage between two Harnu sessions                                                                                                                                                                           | Kit only (P-K). Live in W0.                                                                                                                                                                                                                               |
| A8  | A settings file's `env` block reaches `$.env.get` at the next spawn, resume or park-wake, so §7.6 b is a real route                                                                                                                                                       | Open. The refusal is safe either way: it only removes the parts. W0 plants the file and reads `$.env.get`.                                                                                                                                                |
| A9  | `$.tool.check` for a part answers as the real Bash call would, including `acceptEdits`, a project allow rule, **a blocking settings `PreToolUse` hook** (a query runs no classic hook, TYPES:12883) and **the auto-mode classifier** (an `ask` stays an `ask` in a query) | Shown for `allow` and `ask` in `-p` (R6, R7). Open: the rest. The hook gap is stated, not closed (§7.6 a, Q14).                                                                                                                                           |
| A10 | Claude Code protects its settings files from a session in `acceptEdits` or `manual`                                                                                                                                                                                       | **Argued, not shown** (§7.6 a). W0 probes it from an MCP-spawned child.                                                                                                                                                                                   |
| A11 | The hook's `cwd` follows a `cd` in the Bash tool, and equals `$.session.root()` for a session that never changed directory                                                                                                                                                | **Shown** (R14: `cd sub`, then the part in `sub`, was not a receipt for the root). W0 repeats it on the pinned CLI, including a subagent in an isolated worktree and a root reached through a symlink (a mismatch there is safe: it only costs a re-run). |

## 16. Open questions (C-7)

| Id  | Question                                                                                                                                                                                                                                                                                              | Who decides                             | Proposal                                                                                                                                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Default mode for the operator's own sessions: annotate (proposed) or enforce?                                                                                                                                                                                                                         | Operator                                | Annotate. Revisit after a month of agent-session data.                                                                                                                            |
| Q2  | Should `verify:` also run at worktree creation as a smoke check?                                                                                                                                                                                                                                      | Operator, with WORKTREE owner           | No.                                                                                                                                                                               |
| Q3  | Per-step or per-AC commands?                                                                                                                                                                                                                                                                          | Operator, with T216/ADR-0010 owner      | Not before ADR-0010's AC parser exists.                                                                                                                                           |
| Q4  | Gate an orchestrator's on-behalf claim on the child's receipt in the Mission Log?                                                                                                                                                                                                                     | Operator, with mission skill owner      | Yes, annotate-only, after W3.                                                                                                                                                     |
| Q5  | Stage the gate into Scheduler `act` ticks?                                                                                                                                                                                                                                                            | Operator                                | Yes, enforce, once the approval exists for the repo.                                                                                                                              |
| Q6  | Add a `classic.PostToolUse` `additionalContext` receipt on the `gh pr` call?                                                                                                                                                                                                                          | Implementer (W1)                        | Yes (TYPES:1368).                                                                                                                                                                 |
| Q7  | Live mode switch for running sessions?                                                                                                                                                                                                                                                                | Operator                                | No for v1.                                                                                                                                                                        |
| Q8  | Surface the gate's failure count in Settings → Mods?                                                                                                                                                                                                                                                  | Operator, with P4W1 owner               | Yes, with idea 123's "did" column.                                                                                                                                                |
| Q9  | Show "check: green / stale" in P4W2's band?                                                                                                                                                                                                                                                           | P4W2 owner                              | Yes, from the ledger.                                                                                                                                                             |
| Q10 | `$.model.classify` instead of the word list for rows 7, 9 and 12?                                                                                                                                                                                                                                     | Operator                                | Not in v1; measure the word list's false positives first.                                                                                                                         |
| Q11 | **Trust:** is a per-repo hash pin with a one-time operator approval the right model (§7.2), or should the command also be limited to the default branch's committed copy, or approved per worktree? Should a command the operator wrote themselves in the Startup dialog skip the repo file entirely? | **Operator** (security posture)         | Per-repo hash pin, read from the main checkout through the existing resolver. Re-approve on any change. No per-worktree approval.                                                 |
| Q13 | When the session's permissions would **ask** about a part, should the gate hand the run back (proposed), or surface the question to the person through a pane so they can allow that one run?                                                                                                         | Operator                                | Hand it back. The session's own Bash call already asks the person, in the same place, with the same wording.                                                                      |
| Q14 | A `$.tool.check` query runs no `PreToolUse` hook, so a hook that would block a part is not consulted. Should the gate hand the run back when the merged settings hold a `PreToolUse` hook whose `command` is not Harnu's own?                                                                         | Operator, with the hook-installer owner | Not in v1. Harnu's own hook is in every session, so only a hook that is not Harnu's could count, and W0 should first measure how often one exists. State the gap in the user doc. |
| Q12 | Move the run to the host (a companion `ask` kind with a host-side runner) once an ask broker exists, so no Harnu-staged mod runs a process?                                                                                                                                                           | Operator, with T389 owner               | Revisit when P3W1's broker ships. The pin and disclosure carry over unchanged.                                                                                                    |

## 17. Acceptance-criteria traceability

| AC  | Where                                                                                                                                                                                                                                                                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| U-1 | §3, §5.1 (12 signals, each with a decision, `message_session` and `session.send` included), §5.2                                                                                                                                                                                                                                                             |
| U-2 | §7 (sources compared, decision, D-1 in full)                                                                                                                                                                                                                                                                                                                 |
| U-3 | §6 (the ledger, per part; `classifyBash` fail-safe: an exact neutral allowlist, the `cwd` rule, fuzz and allowlist tables), §7.1-7.6 (trust: the command, the env, every settings source and the merge, what the text runs, what a query does not consult), §8 (argv, cwd, env, permission check, timeouts run to 290/400 s, Esc, capture, nothing runnable) |
| U-4 | §9                                                                                                                                                                                                                                                                                                                                                           |
| C-1 | §4 (every mechanism cited, and run where the design hinges on it)                                                                                                                                                                                                                                                                                            |
| C-2 | §14, §10.2                                                                                                                                                                                                                                                                                                                                                   |
| C-3 | §10, ADR-draft                                                                                                                                                                                                                                                                                                                                               |
| C-4 | §11                                                                                                                                                                                                                                                                                                                                                          |
| C-5 | [`01-prototype.md`](01-prototype.md)                                                                                                                                                                                                                                                                                                                         |
| C-6 | §13                                                                                                                                                                                                                                                                                                                                                          |
| C-7 | §16                                                                                                                                                                                                                                                                                                                                                          |
| C-8 | English throughout; neutral vocabulary; prettier and `tests/no-client-identifiers.test.ts` (in the report)                                                                                                                                                                                                                                                   |
