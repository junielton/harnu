# T452 — Verification gate on "done": a claim is done only after its check ran

**Status:** specified (not implemented) · **Date:** 2026-10-09 (round 2) · **Card:** T452 ·
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
approved that exact command (a hash pin). The mod never reads the working tree. Outside Harnu, the
mod defaults to annotate and runs nothing unless the person configured a command themselves (§7).

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
   pick the command (§7.1). Round 2 takes the command only from operator-approved state (§7).
4. **The Bash hook avoids `tool.call`, out of caution.** A pass-through `tool.call` hook on Bash
   broke `Agent(isolation: "worktree")` on an earlier build (SMOKE:628-650, issue #92533). On
   2.1.296 headless, a later probe found isolation intact (V450). The gate uses `tool.check` and
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
   - A 400 s check was killed at the 300 s timeout (R4).
   - Esc killed a running check within a second and recorded nothing (R5).

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

| Prefix           | Means                                                                                                                                                                                                                                                |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TYPES:n`        | `types/claude-code.d.ts` written by Claude Code **2.1.295**'s `plugin-authoring` skill on 2026-10-09 (21,463 lines). The `claude` that ran every probe reported `2.1.296 (Claude Code)`. Types are regenerated per build, so W0 re-reads every cite. |
| `REF:n`          | The `reference.md` beside those types (215 lines).                                                                                                                                                                                                   |
| `TC:n`           | `src/main/mcp/tool-catalog.ts`.                                                                                                                                                                                                                      |
| `TH:n`           | `src/main/mcp/tool-handlers.ts`.                                                                                                                                                                                                                     |
| `MC:n`           | `src/main/mission-core.ts`.                                                                                                                                                                                                                          |
| `WM:n` / `WI:n`  | `src/main/worktree-manifest.ts` / `src/main/worktree-ipc.ts`.                                                                                                                                                                                        |
| `MA:n`           | `src/main/mods-audit-core.ts`.                                                                                                                                                                                                                       |
| `T389/<file>:n`  | `docs/specs/T389-companion-mod/<file>`.                                                                                                                                                                                                              |
| `T447/<file>:n`  | `docs/specs/T447-harnu-sdk-noun/<file>`.                                                                                                                                                                                                             |
| `SMOKE:n`        | `docs/studies/T389-smoke-evidence.md`.                                                                                                                                                                                                               |
| `DV:n`           | `resources/skills/skills/delivery-verifier/SKILL.md`.                                                                                                                                                                                                |
| `P-K`, `R1`…`R5` | Runs of the **round-2** prototype, recorded in [`01-prototype.md`](01-prototype.md): `P-K` the kit suite, `R1`…`R5` live.                                                                                                                            |
| `P1`…`P6`        | Live runs of the round-1 prototype, kept in `01-prototype.md` for the mechanisms round 2 did not change (the `tool.check` deny, the ledger's classic hooks, worktree isolation).                                                                     |
| `V-*`            | Runs by the T452 round-1 verifier: `V-45` (a 45 s check), `V-A2` and `V-A3`. `V450` is the T450 verifier's B4 re-run. All are summarised in `01-prototype.md` §"Independent runs".                                                                   |

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

| Mechanism                                     | What the gate needs from it                                                                                                                                                                           | Cite                                                   | Shown by                                      |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------- |
| `tool.call` deny on an MCP tool               | `{ deny: reason }` in place of `next` refuses the call; the model reads the reason as an error result                                                                                                 | TYPES:3942-3955, :12701-12711                          | P-K; R2 red (the server never saw the call)   |
| `tool.call` result `context`                  | A note the model reads after the result, "as a PostToolUse hook's is"                                                                                                                                 | TYPES:12728-12736                                      | P-K; R2 green                                 |
| List matcher on the MCP verbs                 | `{ tool: ['mcp__harnu__…', 'mcp__capy__…'] }` is a one-of; literal strings, so no `opaque` chip                                                                                                       | TYPES:5842-5850                                        | P-K (validate lists both names)               |
| `tool.check` deny                             | Runs before the tool; `{ decision: 'deny', reason }` refuses it; a real call carries `tool_use_id`, a query does not. It holds in **every** permission mode, `bypassPermissions` included             | TYPES:3956-3969, :12812-12870; SMOKE:476-487 (B1.6)    | R1, R3; P1; V-45 (bypass); P-K                |
| `tool.check` and `classic.*` on Bash are safe | They leave `Agent(isolation: "worktree")` intact. A Bash `tool.call` broke it on an earlier build, but not in V450 on 2.1.296 headless (§0 fact 4)                                                    | SMOKE:628-650 (B4); V450                               | P4 (with a no-mod control)                    |
| `classic.PostToolUse` / `…Failure`            | The finished call's `tool_name`, `tool_input`, `tool_response`, or `error`. A non-zero Bash exit arrives as `PostToolUseFailure`; a subagent's calls reach the parent's hooks                         | TYPES:7851-7876                                        | P1; V-A2; V-A3; P-K                           |
| `classic.SessionStart`                        | `source: 'startup' \| 'resume' \| 'clear' \| 'compact' \| 'fork'`                                                                                                                                     | TYPES:11643-11648                                      | P-K                                           |
| `session.send`                                | Fires for every plain-text message leaving the session, from the SendMessage tool or `$.session.send`; `next({ ...e, text })` rewrites what is sent with no new approval                              | TYPES:4360-4371, :11553-11640, :2872-2884              | P-K                                           |
| `turn.complete`                               | `{ text }` returned with a different text is shown beneath the answer; the transcript is never rewritten; `e.agentId` marks a subagent's turn                                                         | TYPES:4456-4464, :13280-13351                          | P-K                                           |
| `$.process.spawn`                             | argv (no shell of its own), `cwd`, `env`; **the loop is the child's life**: leaving it, `return()`, `next.signal` aborting or a module unload kills the child                                         | TYPES:3516-3553, :8086-8125                            | R3, R4 (timeout kill), R5 (Esc kill)          |
| `$.clock.after`                               | A timer whose callback calls `return()` on the stream: the gate's own timeout                                                                                                                         | TYPES:3454, :12626                                     | R4; P-K                                       |
| Hook budget                                   | 10 s of the hook's **own** time; the clock stops while a `$` call is in flight, except `$.clock` waits; `.catch` grace 1 s                                                                            | TYPES:5089-5129, REF:154; SMOKE:418-432 (B1.2, 15 min) | R3 (290 s); V-45                              |
| `next.signal` on Esc                          | Aborts the dispatch at once (SMOKE B1.4: "the in-flight fetch is torn down")                                                                                                                          | REF:154-157; SMOKE:447-457                             | R5                                            |
| `.catch` fail-open                            | A hook that throws is skipped and the chain goes on, unless `.catch` answers                                                                                                                          | TYPES:3931-3940, REF:78-79                             | P-K (validate lists every gate "with .catch") |
| `$.state` ledger                              | Per session, held by the host, kept across a hot reload; `atom`/`read`/`update` write with `ifVersion` and retry                                                                                      | REF:118, TYPES:14692-14735                             | P-K; R1                                       |
| `$.env.get`                                   | A literal name; resolves the process env Harnu set at spawn                                                                                                                                           | TYPES:3588-3598                                        | R1-R5; P-K (`mock.env`)                       |
| `$.ui.status`                                 | A status-line text while the check runs: SMOKE B1.3 shows only a spinner during a `tool.check` hold                                                                                                   | TYPES:2477; SMOKE:434-445                              | R5 (the line showed and cleared)              |
| Validate: `$` only to top-level functions     | `$` passed to a closure fails validation                                                                                                                                                              | `docs/dev/companion-mod.md:48-61`                      | P-K (round 1's first validate failed on it)   |
| Kit                                           | `$.tool.call`, `$.tool.check` (a **query**: `ToolCheckArgs` = `tool` + `input`, TYPES:12796), `$.classic.*`, `$.session.send`, `$.turn.complete`, `mock.env`, `mock.clock`, `test(name, { options })` | TYPES:15440-15490, :15900-15957                        | P-K                                           |
| `$.ui.notice`                                 | **Not used**: it shows a line under an open permission dialog only, and a dispatched executor has none                                                                                                | TYPES:2334-2347                                        | argued                                        |
| `$.fs.read`                                   | **Not used** any more. It reads "relative to the working directory" (TYPES:3230); round 1 read `WORKTREE.md` with it, which was the flaw §7.1 removes                                                 | TYPES:3223-3242                                        | P-K (every test fails on a `fs.read`)         |

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
| G    | A part could not finish (timeout, spawn failure)                                                                                                    | `unrun`       | **deny**: "the gate could not run `<part>` (…). Run it yourself with Bash; a green run after your last edit counts." |
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
failed). For Bash, the command is split into **segments** at `&&`, `||`, `;` and `|`, and each
segment loses its trailing redirections (`2>&1`, `> out.txt`).

| Finished call                                                                                           | Counts as                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Edit`, `Write`, `NotebookEdit`, succeeded                                                              | an edit (`lastEdit = "<tool> <path>"`)                                                                                                                    |
| the same, failed                                                                                        | nothing                                                                                                                                                   |
| `Bash` with a segment **equal** to a part                                                               | a run of each part it equals: green on `PostToolUse`, red on `PostToolUseFailure` (V-A2 showed a non-zero exit arrives as the latter)                     |
| the same, with `tool_response.backgroundTaskId` set                                                     | nothing: a background run reports before it finishes                                                                                                      |
| `Bash` whose segments are each neutral or a **narrower** run of a part (the part followed by arguments) | nothing. `npx vitest run tests/a.test.ts` is no receipt for `npx vitest run`, and no edit either                                                          |
| `Bash` whose every segment starts with a neutral command                                                | nothing: `git status/log/diff/show/add/commit/push/fetch/rev-parse/rev-list/branch`, `gh`, `ls`, `cat`, `head`, `tail`, `wc`, `rg`, `grep`, `pwd`, `echo` |
| any other `Bash`                                                                                        | **an edit** (conservative: `sed -i`, `npm install`, a codegen script)                                                                                     |

So the parts count **one by one**:

- `npm run typecheck` then `npx vitest run 2>&1 | tail -40`, as two Bash calls, is a full receipt
  (P-K).
- If the session ran only `npm run typecheck`, the gate runs only `npx vitest run` (P-K).
- The joined form `npm run typecheck && npx vitest run` counts for both parts. On failure both are
  marked red, because the gate cannot tell which part failed.
- A focused run is deliberately no receipt, because it does not prove the suite. It is not an edit
  either, so it costs nothing.

Other choices:

- **A commit is not an edit** (P-K).
- **Subagents count.** A subagent's `Write` reached the parent's ledger and staled a receipt
  (V-A3).
- **Equality, not "contains".** Round 1 matched the whole joined check as a substring, so separate
  runs never formed a receipt. Equality per segment fixes that. It still accepts `echo` forgeries
  only as far as N4 allows: `echo npm run typecheck` has the segment `echo npm run typecheck`,
  which is not equal to a part, so even that forgery fails.

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

| Step                          | Inside Harnu                                                                                                                                                                                                                                                                                                                        |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Where the key lives        | `verify:` in `WORKTREE.md` front matter: one string, or a list of **parts** run in order. Each part is a POSIX command line (ADR-0005). The overlays (`WORKTREE.local.md`, `.claude/worktree.md`) and the `worktree-manifest.md` alias apply exactly as for the other keys.                                                         |
| 2. Who reads it               | **Harnu's main process**, with the existing resolver over `readManifestSources(repoRoot)`: the repo's **main checkout**, never the session's worktree. There is one reader, so the gate and `create_worktree` can never disagree. The resolver also normalises BOM and CRLF (WM:178), which round 1's ad-hoc parser did not.        |
| 3. What the operator sees     | The parts, verbatim, with their SHA256 over the canonical JSON list, in a "Needs you" item and in the folder's Startup dialog: "Harnu will run these commands to check a claim of done in this repo." The same disclosure posture as `DisclosedWorktreeCommands`.                                                                   |
| 4. What the operator approves | The **hash**, once per repo (`<userData>/verify-gate/approvals.json`, `{ repoRoot → { hash, parts, approvedAt } }`). There is no verb for it, so an agent cannot approve.                                                                                                                                                           |
| 5. What the session gets      | At spawn, when the current hash equals the approved one: `HARNU_VERIFY_GATE=<mode>` and `HARNU_VERIFY_CMD=<the approved parts as JSON>`. When it differs: `HARNU_VERIFY_GATE=<mode>` and **no** `HARNU_VERIFY_CMD`. The gate then answers rule D ("no operator-approved verify command") and a "Needs you" item asks to re-approve. |
| 6. What the mod reads         | Only those two variables (`$.env.get`, literal names). **It never reads the working tree** (P-K fails any test whose gate calls `fs.read`; R1 shows a model-edited `WORKTREE.md` changing nothing).                                                                                                                                 |

Outside Harnu (no `HARNU_VERIFY_GATE` in the env):

- The default mode is **`annotate`**, which never runs anything.
- `enforce` runs only the `check` userConfig option. That option lives in the person's own settings
  (`pluginConfigs`), not in any repo, and is set by them through `/config`.
- `WORKTREE.md` is never read there either.

What this buys, and its limits:

- **G4 holds against the model.** The model can edit any file in its worktree, the main checkout's
  `WORKTREE.md` included if its permissions reach it. A changed command has a new hash, which no
  operator approved, so nothing runs. The model cannot set the claude process's own env: a Bash
  `export` reaches only that Bash child.
- **A fork's PR is covered.** The command comes from the main checkout and the operator's pin, never
  from the branch.
- **It is not a boundary against another mod.** A mod can `$.env.set` the variable (TYPES:3609) or
  hook `env.get`. A mod can also run any process itself. Mods of one tier are not isolated
  (ADR-0018 D3), and that is disclosed in the Mods tab, not solved here.
- **The approval is per repo, not per worktree.** An approved command runs in every session of that
  repo, which is the intent. Changing it means a new approval.

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

## 8. Running it safely (U-3)

### 8.1 What runs, and where

- **Only approved parts** (§7.2), one at a time, in order. Each runs as `['sh', '-c', part]`
  through `$.process.spawn`, which has no shell of its own (TYPES:3516-3553).
- **Working directory:** `$.session.root()`, the session's project root, which for a Harnu
  worktree session is the worktree. A shell `cd` does not move it (TYPES:2776-2783).
- **Environment:** the session's, plus `CI=1`, so test runners take their non-interactive path.
  Standard input is closed from the start, because `input` is absent (TYPES:8098-8104), so a prompt
  in the check fails fast instead of hanging.
- **No denylist.** Round 1's substring denylist is removed. The guard is that the operator saw and
  approved the exact text (§7.2), not a list of bad words.
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

| Situation                                                       | Result                                                                                                       |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| No `verify:` key in the repo                                    | Rule D: pass, "no operator-approved verify command; this claim is unverified".                               |
| A `verify:` key the operator has not approved, or changed since | Rule D, plus a "Needs you" item to approve the shown parts.                                                  |
| The claimed card's ACs are only `visual`/`manual`/`review` (W3) | Rule D's note, naming the kinds.                                                                             |
| Outside Harnu, no `check` configured                            | Rule D: "no check is configured".                                                                            |
| A part cannot start, or outlives its timeout                    | Rule G: deny, "run it yourself"; the session's own Bash run, under its own permissions, becomes the receipt. |

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

| Rule                                                                                                                                                          | Its intent                                                                     | How the gate meets it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SEC-4: "Nothing security-relevant is read from env, cwd or project files; the single exception is the literal `HARNU_SPAWN_TOKEN` nonce" (T389/00-master:497) | A value the session can influence must never steer a security decision         | **Project files and cwd: nothing is read** (round 2 removed `$.fs.read`). **Env:** two literal names Harnu sets at spawn. The model cannot change the claude process's env; a Bash `export` reaches only that Bash child. Another mod can (`$.env.set`, or a hook on `env.get`), and could then make the gate run a command of its choosing. But that mod can already run any process itself, so the gate gives it nothing new. That is the same exposure SEC-4 accepts for the token (ADR-0018 D3), and the Mods tab is where it is disclosed. |
| SEC-9a: no `$.process.run`/`spawn` in the companion                                                                                                           | No generic "run this" in a mod staged into every session                       | The gate runs only operator-approved, disclosed text (§7.2), never input from the model, a card, a Mission field or the host channel. It never exposes a "run" to anyone. That is the difference between a check and a generic runner.                                                                                                                                                                                                                                                                                                          |
| SEC-9b: no `$.mcp.call` in the companion                                                                                                                      | No mod-side write path into Harnu that bypasses the server's audit and scoping | The gate makes no `$.mcp.call`. W3's writes go through T447's noun, which carries the scoping and the audit.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| SEC-9d: no Bash `tool.call` matcher                                                                                                                           | Do not break worktree subagents (#92533)                                       | None. The gate uses `tool.check` and classic hooks (§0 fact 4).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

The same static test the companion has (`api-surface-scan.mjs`) gets a gate profile in W1: allowed
hooks and calls equal the gate's `api-surface.json`, with no `fs.*`, no `http.*`, no `mcp.call`, no
Bash `tool.call`, and `process.spawn` called only from `runPart`.

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

A session with no entry, one started before W2 shipped, gets the folder default for an operator
session. That is stated in the user doc, not hidden.

**Mode applies to the next spawn.** The mod reads the env once per call, but the env is fixed at
spawn, so a running session keeps its mode (Q7).

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

| Id  | Risk                                                                             | Severity | Handling                                                                                                                                                                                            |
| --- | -------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| K0  | **The gate becomes a way to run code the model chose**                           | High     | Closed by design (§7.2): the command comes only from the operator-approved hash or the person's own settings, never from the tree. R1 (live) and P-K test it. The W1 static profile forbids `fs.*`. |
| K1  | A model forges a receipt or claims through an unhooked path                      | Medium   | Non-goal N4. Segment equality defeats `echo <part>` (§6.2). The verifier never counts a receipt as proof (§9.2).                                                                                    |
| K2  | Another mod calls `mission_update_step` directly before T447 ships               | Low      | §5.1 row 10; closed by T447's guard.                                                                                                                                                                |
| K3  | Neutral list too narrow: a harmless Bash call counts as an edit, so an extra run | Low      | Costs one run. The list is data and grows with evidence.                                                                                                                                            |
| K4  | Neutral list too wide: a tree-changing command treated as neutral                | Medium   | Read-only and git-plumbing verbs only. `git checkout`/`stash`/`pull` are deliberately **not** neutral.                                                                                              |
| K5  | A slow suite makes every claim wait                                              | Low      | Once per edit cycle; parts the session already ran are skipped; Esc kills it (R5); rule G hands it back.                                                                                            |
| K6  | #92533's status changes again                                                    | Low      | The gate never registers `tool.call` on Bash. W0 records the result either way (§13).                                                                                                               |
| K7  | A later build changes classic-event routing (V-A2, V-A3)                         | Medium   | W0 re-runs both. A CLI ceiling in the gate's `api-surface.json` forces annotate above the tested build.                                                                                             |
| K8  | The operator approves a command without reading it                               | Medium   | The disclosure shows the parts verbatim, and an approval is per repo and per hash. Any change asks again. This is the same posture as `create_worktree`'s confirm.                                  |

## 13. Implementation outline (C-6)

S ≈ ≤ 1 day, M ≈ 2-3 days, L ≈ a week.

| Wave | Size | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Depends on                              |
| ---- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| W0   | S    | Spike on the pinned CLI: A1, A4, A5, A7 (§15) live; 300 s and 600 s parts inside a real Harnu session; re-read the regenerated types for every cite in §4. **#92533 check:** re-run SMOKE B4's shape (pass-through Bash `tool.call`, `isolation: "worktree"`) interactively and in a tick, `rtk` off. If isolation holds everywhere, the `tool.check` + classic shape **stays**: it works either way, and moving back buys nothing. Record the result in SMOKE and relax SEC-9d only by a separate ADR. | —                                       |
| D-1  | S    | §7.3 in full: `KNOWN_KEYS`, `PartialManifest`, `normalizeRecord`, `mergeManifest`, `ResolvedManifest`, `verifyHash`, tests (including the alias, the overlays and CRLF). The worktree-manifest skill authors the key. This repo's `WORKTREE.md` gains it.                                                                                                                                                                                                                                               | —                                       |
| W1   | M    | The mod: the round-2 prototype plus rows 3-4, single-flight, its `api-surface.json`, a CLI ceiling, the static profile of §10.2 (no `fs.*`, `http.*`, `mcp.call`, Bash `tool.call`), and `mod-step.mjs` coverage.                                                                                                                                                                                                                                                                                       | W0, D-1                                 |
| W2   | L    | Host side: staging and `--plugin-dir`; **the approval store, its disclosure UI ("Needs you" item, Startup dialog) and the env injection**; the global and per-folder switch; the durable per-session mode (§11.1); the three Mods-tab fixes (§11.3).                                                                                                                                                                                                                                                    | W1                                      |
| W3   | M    | Mission writes through T447's noun: `dependencies: ['harnu']`, the `mission_log` receipt with the HEAD sha, the step blocker, row 8, the AC-kind filter.                                                                                                                                                                                                                                                                                                                                                | W1, T447 (noun waves, D-A child lookup) |
| W4   | S    | "Also outside Harnu" switch and marketplace entry, like P4W3.                                                                                                                                                                                                                                                                                                                                                                                                                                           | W2                                      |

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

| Id  | Assumption                                                                                      | Status                                                                                                  |
| --- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| A1  | `tool.call` deny and `context` on `mcp__harnu__*` work in a live **Harnu** session              | Shown live against a stand-in server (R2, P5, P6). Left: Harnu's server and "Ask before agent actions". |
| A2  | A non-zero Bash exit raises `classic.PostToolUseFailure`                                        | **Shown** (V-A2).                                                                                       |
| A3  | Classic tool events fire for a subagent's calls, into the parent's ledger                       | **Shown** (V-A3).                                                                                       |
| A4  | `$.state` does not survive `--resume`                                                           | Open. The seeding is safe either way: if state does survive, the seed is skipped (`lastEditSeq > 0`).   |
| A5  | `turn.complete`'s note shows in the terminal and the desktop surface                            | Open.                                                                                                   |
| A6  | `$.process.spawn`'s child dies on Esc and on the timer's `return()`                             | **Shown** (R5, R4).                                                                                     |
| A7  | `session.send` rewrites the text the receiver reads, for SendMessage between two Harnu sessions | Kit only (P-K). Live in W0.                                                                             |

## 16. Open questions (C-7)

| Id  | Question                                                                                                                                                                                                                                                                                              | Who decides                        | Proposal                                                                                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Default mode for the operator's own sessions: annotate (proposed) or enforce?                                                                                                                                                                                                                         | Operator                           | Annotate. Revisit after a month of agent-session data.                                                                            |
| Q2  | Should `verify:` also run at worktree creation as a smoke check?                                                                                                                                                                                                                                      | Operator, with WORKTREE owner      | No.                                                                                                                               |
| Q3  | Per-step or per-AC commands?                                                                                                                                                                                                                                                                          | Operator, with T216/ADR-0010 owner | Not before ADR-0010's AC parser exists.                                                                                           |
| Q4  | Gate an orchestrator's on-behalf claim on the child's receipt in the Mission Log?                                                                                                                                                                                                                     | Operator, with mission skill owner | Yes, annotate-only, after W3.                                                                                                     |
| Q5  | Stage the gate into Scheduler `act` ticks?                                                                                                                                                                                                                                                            | Operator                           | Yes, enforce, once the approval exists for the repo.                                                                              |
| Q6  | Add a `classic.PostToolUse` `additionalContext` receipt on the `gh pr` call?                                                                                                                                                                                                                          | Implementer (W1)                   | Yes (TYPES:1368).                                                                                                                 |
| Q7  | Live mode switch for running sessions?                                                                                                                                                                                                                                                                | Operator                           | No for v1.                                                                                                                        |
| Q8  | Surface the gate's failure count in Settings → Mods?                                                                                                                                                                                                                                                  | Operator, with P4W1 owner          | Yes, with idea 123's "did" column.                                                                                                |
| Q9  | Show "check: green / stale" in P4W2's band?                                                                                                                                                                                                                                                           | P4W2 owner                         | Yes, from the ledger.                                                                                                             |
| Q10 | `$.model.classify` instead of the word list for rows 7, 9 and 12?                                                                                                                                                                                                                                     | Operator                           | Not in v1; measure the word list's false positives first.                                                                         |
| Q11 | **Trust:** is a per-repo hash pin with a one-time operator approval the right model (§7.2), or should the command also be limited to the default branch's committed copy, or approved per worktree? Should a command the operator wrote themselves in the Startup dialog skip the repo file entirely? | **Operator** (security posture)    | Per-repo hash pin, read from the main checkout through the existing resolver. Re-approve on any change. No per-worktree approval. |
| Q12 | Move the run to the host (a companion `ask` kind with a host-side runner) once an ask broker exists, so no Harnu-staged mod runs a process?                                                                                                                                                           | Operator, with T389 owner          | Revisit when P3W1's broker ships. The pin and disclosure carry over unchanged.                                                    |

## 17. Acceptance-criteria traceability

| AC  | Where                                                                                                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U-1 | §3, §5.1 (12 signals, each with a decision, `message_session` and `session.send` included), §5.2                                                           |
| U-2 | §7 (sources compared, decision, D-1 in full)                                                                                                               |
| U-3 | §6 (the ledger, per part, against the session's own log), §7.1-7.2 (trust), §8 (argv, cwd, env, timeouts run to 290/400 s, Esc, capture, nothing runnable) |
| U-4 | §9                                                                                                                                                         |
| C-1 | §4 (every mechanism cited, and run where the design hinges on it)                                                                                          |
| C-2 | §14, §10.2                                                                                                                                                 |
| C-3 | §10, ADR-draft                                                                                                                                             |
| C-4 | §11                                                                                                                                                        |
| C-5 | [`01-prototype.md`](01-prototype.md)                                                                                                                       |
| C-6 | §13                                                                                                                                                        |
| C-7 | §16                                                                                                                                                        |
| C-8 | English throughout; neutral vocabulary; prettier and `tests/no-client-identifiers.test.ts` (in the report)                                                 |
