# T452 — Verification gate on "done": a claim is done only after its check ran

**Status:** specified (not implemented) · **Date:** 2026-10-09 · **Card:** T452 · **ADR:**
[`ADR-draft.md`](ADR-draft.md) (proposed; numbered at merge)

Files: this spec, [`01-prototype.md`](01-prototype.md) (the prototype hooks module, its tests and
the real output of `claude plugin validate`, `claude plugin test`, `tsc` and four live runs) and
[`ADR-draft.md`](ADR-draft.md) (where the gate lives and where its check comes from).

## 0. Summary

Harnu ships a third, small mod named **`harnu-verify-gate`**. It watches the claims a session makes
that its own work is finished. When the session wrote code since its last green check, the gate
runs the repo's check before the claim goes through. A red check turns the claim into a refusal
that carries the failing output. "Done" then means the check ran on the tree being claimed.

Six facts shape the design. Each is cited below and most were shown by a run:

1. **Most executors cannot claim a Mission step.** A session spawned by MCP `create_session` gets
   no Harnu MCP server at all (`src/main/pty.ts:811-819`). It "reports" through native
   `SendMessage`, `git push` and `gh pr create` (ADR-0015:24-38). The gate therefore gates the
   claims each session shape can actually make (§3, §5), not only `mission_update_step`.
2. **`mission_update_step` cannot be rewritten to "blocked".** Its `set` takes `title` and
   `proof: 'claimed'` only (TC:1464-1480). The "blocked" outcome is a **refusal** with the
   failing output. When the T447 noun ships, a Mission blocker is raised as well (§9).
3. **A `tool.call` hook on Bash breaks worktree-isolated subagents**, even when it only passes the
   call through (SMOKE:628-650, issue #92533). The Bash claim (`gh pr create`) is gated at
   `tool.check`, and Bash runs are observed at `classic.PostToolUse`/`PostToolUseFailure`. That
   shape kept isolation intact in a live run (01-prototype §P4).
4. **The companion may not run processes or call MCP** (T389 SEC-9 a/b, T389/00-master:502). The
   gate must run a process, so it cannot live in `harnu-companion`. It is a separate mod (§10).
5. **No check command exists anywhere today.** Steps carry a verification _level_
   (`MC:76-95`), card ACs carry a `verify:` _kind_ by convention only (no parser in `src/`), and
   `WORKTREE.md` has no such key (`src/main/worktree-manifest.ts:139-148`). The spec adds a
   `verify:` key to `WORKTREE.md` (§7). That is the one server change it needs (D-1).
6. **A long check fits.** A hook's 10 s budget stops while a `$` call is in flight
   (TYPES:5100-5129). A 15 s check inside `tool.check` was run live and its deny was delivered
   (01-prototype §P3). This repo's own check measures 14.9 s (`npm run typecheck`) plus 38.4 s
   (`npx vitest run`) on this machine (§8.2).

The gate is a **self-check by the authoring session**. It never verifies a step, never changes a
proof label and never replaces the delivery-verifier (§9).

## 1. Origin and scope

**Origin.** Ideas 44 and 68 of the operator's ideation report (`.harnu/out/claude-code-mods-ideas.md`
in the main checkout, gitignored). They are in the "Done gates / verification" cluster with 38, 55,
63 and 67:

- Idea 44, "Verification gate on 'done' (executor self-check)": "When the executor says a step is
  done (`mcp.call(mission_update_step status:done)` from inside), the mod runs the step's `verify`
  command via `process.run` first; if it fails, the call is rewritten to `blocked` with the stderr
  tail attached". Three premises of this pitch are false on this build: no `status` field exists
  on that verb, no step carries a `verify` command, and the rewrite to `blocked` has no target
  field. §5 and §7 replace each one.
- Idea 68, "Verification receipt before 'done'": "On `turn.complete`, if the reply text claims
  completion … but no Bash test/typecheck/build ran since the last edit, inject a notice and redraw
  the response row with a '⚠ unverified' badge." It uses `$.model.classify`, which exists: one
  completion on the engine's small fast model that answers one of the given labels
  (TYPES:2638-2656). v1 uses a fixed word list instead (§5.1 row 9). The list costs no request,
  answers the same way every time, and keeps the `model` chip off the Mods tab (§11.3). Using `classify` to cut false
  positives is Q10.

The report ranks the pair fifth of its "Ten I would build first": "Rewrites the executor's own
'step done' into 'blocked' when the step's verify command fails. Done means the check ran."

**Goals.**

- G1. A session that edited files cannot make a gated claim on a tree whose check is red, or whose
  check never ran after the last edit, without the claim being refused or flagged.
- G2. The judgement uses the session's **own** tool-call log (what it edited, what it ran). The
  model's words are not evidence.
- G3. A green run the session already made counts as the receipt. The gate re-runs only when no
  run covers the last edit.
- G4. Whatever the gate learns is visible to a verifier and the operator as a hint, never as proof.
- G5. Nothing breaks when the gate is absent, off, fails, or runs outside Harnu.

**Non-goals.**

- N1. Grading acceptance criteria. That is the delivery-verifier's job (§9).
- N2. Recording a `verified` proof or calling `mission_verify_step`. The gate never does either.
- N3. Gating the operator. A claim the operator makes in the UI never passes through a session.
- N4. A security boundary. A determined model can still claim through a path the gate does not
  see (§12, R1). The gate catches the honest mistake, the stale "all tests pass", which is the
  common one.
- N5. Per-AC commands. v1 runs one repo-wide check. Per-AC and per-step commands are open (Q3).

## 2. Conventions

Citations use these prefixes:

| Prefix          | Means                                                                                                                                                                                                                                                                        |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TYPES:n`       | `types/claude-code.d.ts` that Claude Code **2.1.295**'s `plugin-authoring` skill wrote on 2026-10-09 (21,463 lines). The CLI that ran every probe reported `2.1.296 (Claude Code)`. The types are regenerated per build, so an implementation re-reads them, as §13 W0 says. |
| `REF:n`         | The `reference.md` beside those types (215 lines).                                                                                                                                                                                                                           |
| `TC:n`          | `src/main/mcp/tool-catalog.ts`.                                                                                                                                                                                                                                              |
| `TH:n`          | `src/main/mcp/tool-handlers.ts`.                                                                                                                                                                                                                                             |
| `MC:n`          | `src/main/mission-core.ts`.                                                                                                                                                                                                                                                  |
| `T389/<file>:n` | `docs/specs/T389-companion-mod/<file>`.                                                                                                                                                                                                                                      |
| `T447/<file>:n` | `docs/specs/T447-harnu-sdk-noun/<file>`.                                                                                                                                                                                                                                     |
| `SMOKE:n`       | `docs/studies/T389-smoke-evidence.md`.                                                                                                                                                                                                                                       |
| `DV:n`          | `resources/skills/skills/delivery-verifier/SKILL.md`.                                                                                                                                                                                                                        |
| `P-<id>`        | A run recorded in [`01-prototype.md`](01-prototype.md): `K` the kit suite, `P1`…`P6` the live runs (P5 and P6 against a stand-in MCP server named `harnu`).                                                                                                                  |

"Author" means a session whose own ledger (§6) holds at least one edit. "Claim" means one of the
signals in §5. "Check" means the command §7 resolves.

## 3. Who can claim "done", by session shape

Which claims a session can make depends on how it was started. Harnu has four shapes:

| Shape                        | Harnu MCP?                                                                                                              | How it says "done" today                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Operator's own session       | yes (`pty.ts:820-824`, app-managed `--mcp-config` first)                                                                | any verb: `mission_update_step`, `move_card`, `mission_request_close`; Bash `gh pr …`; its reply |
| Board / manifest dispatch    | yes. Sets `spawnedBy: 'agent'`, not `agentControlled` (`src/renderer/src/stores/sessions.ts:3135-3139`, ADR-0015:33-37) | the same verbs, scoped by convention to its card; `gh pr create`; its reply                      |
| MCP `create_session` child   | **no**. `agentControlled: true` (`sessions.ts:3229-3231`) withholds the server (`pty.ts:811-819`)                       | `git push`, `gh pr create`, a `SendMessage` report to its owner (ADR-0015:24-32), its reply      |
| Scheduler tick (`claude -p`) | observe: read verbs only, no Bash, no Edit. act: full toolset (`docs/harnu-features.md`, Scheduler)                     | observe: none. act: like an operator session, unattended                                         |

Two consequences:

- The pitch's own target, an executor calling `mission_update_step`, exists only for the first two
  shapes. The third shape is the one Harnu's `orchestrate-delivery` skill dispatches, and this very
  unit was dispatched that way. Its claims are `gh pr create`, `SendMessage` and its reply.
- `mission_update_step`'s own description calls the claim "the owner's 'I believe this is done,
  unverified'" (TC:1466). An orchestrator often claims a step **on behalf of** a child. It edited
  nothing, so its ledger is empty and it is not the author. The gate lets that claim through
  untouched (§5.2 rule A), because the orchestrator's tree is not the tree being claimed. Gating an
  orchestrator's claim on its child's receipt is Q4.

## 4. The engine contract the gate relies on (C-1)

Every mechanism below is cited from the 2.1.295 types. The column "Shown by" names the run that
exercised it; "argued" marks the few the design rests on without a run of its own.

| Mechanism                                                                                       | What the gate needs from it                                                                                                                                                                              | Cite                              | Shown by                                                   |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------- |
| `tool.call` deny                                                                                | `{ deny: reason }` in place of `next` refuses the call; the model reads the reason as an error result                                                                                                    | TYPES:3942-3955, :12701-12711     | P-K, P5 (live: the refused claim never reached the server) |
| `tool.call` result `context`                                                                    | A note the model reads after the result, "as a PostToolUse hook's is"                                                                                                                                    | TYPES:12728-12736                 | P-K, P6 (live), P2                                         |
| `tool.call` list matcher                                                                        | `{ tool: ['Edit', 'Write', 'NotebookEdit'] }` is a one-of                                                                                                                                                | TYPES:5842-5850                   | P-K (validate output)                                      |
| `tool.check` deny                                                                               | Runs before the tool; `{ decision: 'deny', reason }` refuses it in every mode; a real call carries `tool_use_id`, a query does not                                                                       | TYPES:3956-3969, :12812-12870     | P1, P3, P-K                                                |
| `tool.check` on Bash is safe                                                                    | Unlike `tool.call` on Bash, it does not break `Agent(isolation: "worktree")`                                                                                                                             | SMOKE:628-650 (B4)                | P4 (with control)                                          |
| `classic.PostToolUse` / `…Failure`                                                              | The finished call's `tool_name`, `tool_input`, `tool_response`, or `error` on failure                                                                                                                    | TYPES:7851-7876                   | P1 (an edit was seen), P-K                                 |
| `turn.complete`                                                                                 | `{ text }` returned with a different text is shown beneath the answer; the transcript is never rewritten; `e.agentId` marks a subagent's turn                                                            | TYPES:4456-4464, :13280-13351     | P-K                                                        |
| `$.process.run`                                                                                 | argv (no shell of its own), `cwd`, `timeoutMs` 30 s default and 10 min cap; rejects on timeout; `exitCode`; 4 MiB per stream                                                                             | TYPES:3498-3515, :7999-8054       | P1, P3, P-K                                                |
| Hook budget                                                                                     | 10 s of the hook's **own** time; the clock stops while any `$` call is in flight, except `$.clock` waits; `.catch` handler grace 1 s                                                                     | TYPES:5089-5129, REF:154          | P3 (a 15 s check)                                          |
| `.catch` fail-open                                                                              | A hook that throws is skipped and the chain goes on, unless `.catch` answers; `next.called` says whether `next` already ran                                                                              | TYPES:3931-3940, REF:78-79        | P-K (validate lists each gate "with .catch")               |
| `$.state` ledger                                                                                | Per session, held by the host, kept across a hot reload; `atom`/`read`/`update` write with `ifVersion` and retry                                                                                         | REF:118, TYPES:14692-14735        | P-K, P1                                                    |
| `$.fs.read`, `$.session.root`                                                                   | Read `WORKTREE.md`; the session's project root, which a shell `cd` does not move                                                                                                                         | TYPES:3223-3242, :2776-2783       | P1, P-K                                                    |
| `$.clock.now`                                                                                   | The run's time for the receipt; stubbed by `mock.clock` in tests                                                                                                                                         | TYPES:3427-3433, :15440-15452     | P-K                                                        |
| Validate rule: `$` only to top-level functions                                                  | `$` passed to a closure fails validation                                                                                                                                                                 | `docs/dev/companion-mod.md:48-61` | P-K (first validate failed on it)                          |
| Kit: `$.tool.call`, `$.tool.check`, `$.classic.*`, `$.turn.complete`, `test(name, { options })` | The suite drives each hook. `$.tool.check` in the kit is a **query** (`ToolCheckArgs` = `tool` + `input`, TYPES:12796), so the real-call run path at `tool.check` is shown live (P1, P3), not in the kit | TYPES:15900-15957                 | P-K                                                        |
| `$.ui.notice`                                                                                   | **Not used.** It shows a line under an open permission dialog only (TYPES:2334-2347). A dispatched executor runs with no dialog, so the note rides the result instead (`context`)                        | TYPES:2334-2347                   | argued                                                     |

## 5. The "done" signals (U-1)

### 5.1 Every way a session claims completion, and what the gate does

"Intercepted" means the gate judges the claim (§5.2). "Deny" refuses it with the reason. "Annotate"
lets it through with a note. "Pass" means untouched.

| #   | Signal                                                                                                | Who can raise it (§3)                                    | Hook                                                           | Decision                                                                                                                                                                                                                                                                     |
| --- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `mcp__harnu__mission_update_step` with `set.proof === 'claimed'`                                      | operator session, board dispatch                         | `tool.call`, matcher `{ tool: [mcp__harnu__…, mcp__capy__…] }` | **Intercepted. Deny** on red or unrunnable; **annotate** on green (receipt), stale-in-annotate-mode, or no check. A `set` without `proof` (a title edit) passes.                                                                                                             |
| 2   | `mcp__harnu__move_card` with `to: 'review'`                                                           | operator session, board dispatch                         | `tool.call`, same matcher shape                                | **Intercepted**, as row 1. `backlog`/`ready` pass. `done` is not a value the verb takes (TC:961, `roadmap-core.ts:744`).                                                                                                                                                     |
| 3   | `mcp__harnu__mission_request_close`                                                                   | owner session                                            | `tool.call`                                                    | **Annotate only**, and only when this session is an author with no green check after its last edit. The server already refuses unless the fixed end is `verified` by a non-builder (TC:1637-1655, MC:704-734). A deny would add nothing, and the owner rarely authored code. |
| 4   | `mcp__harnu__mission_verify_step` with verdict `met` or `needs-human`, from an author                 | operator session, board dispatch                         | `tool.call`                                                    | **Intercepted. Deny** when this author's own check is red. Otherwise **annotate**, saying a verification by an author lands `self-verified` unless the step's session links name someone else (TH:4455-4466). The gate never changes the verdict or the label.               |
| 5   | Bash `gh pr create` (not `--draft`/`-d`) and `gh pr ready`                                            | every shape with Bash                                    | **`tool.check`** on Bash (never `tool.call`, §4)               | **Intercepted. Deny** on red or unrunnable. On green or no check the engine's own verdict stands (a `tool.check` answer carries no note; the receipt rides row 6 instead, Q6). A query (`tool_use_id` absent) never runs a check; it judges from the ledger alone.           |
| 6   | Bash `git push`                                                                                       | every shape with Bash                                    | none                                                           | **Pass.** A push is not a claim; executors push work in progress, and a push is how work survives a crash.                                                                                                                                                                   |
| 7   | `SendMessage` whose `message` is a string that reads as a completion report                           | every shape; the only claim channel of an MCP-less child | `tool.call` on `SendMessage` (safe: B4 is Bash-only)           | **Annotate by rewrite** (W2): one receipt line appended to the message, `[verify-gate] <cmd> green after the last edit` or `UNVERIFIED: no green check since <last edit>`. Never denied: a report of a red check is exactly what an orchestrator needs to receive.           |
| 8   | The T447 noun's `harnu.missionStepClaim` and `harnu.cardMove { to: 'review' }`, raised by another mod | any session with the `harnu` mod loaded                  | a hook on the noun's event (T447/01-contract:197-204)          | **Intercepted** (W3, after T447 ships), as rows 1 and 2, answering the noun's own refusal shape (`{ ok: false, error: 'REFUSED' }`, T447/01-contract:53-86).                                                                                                                 |
| 9   | The reply text (`turn.complete`) matching the completion word list                                    | every shape                                              | `turn.complete`                                                | **Annotate**: when the main loop's answer (`agentId` absent) matches and no green check covers the last edit, a line is shown beneath the answer. The transcript is never rewritten (TYPES:4456-4464), so this warns the human and changes nothing the model reads.          |
| 10  | A direct `$.mcp.call('harnu', 'mission_update_step', …)` from another mod                             | any mod                                                  | none in v1                                                     | **Not intercepted.** T447's guard denies every direct call into `harnu` from any mod but its own (T447/03-security:33-60, guard at :50-56), which closes it once T447 ships. Until then it is a known gap (§12 R2).                                                          |
| 11  | Writing `.harnu/REPORT.md`, a commit message, a PR body saying "done"                                 | every shape                                              | none                                                           | **Pass.** These are prose. The receipt on row 7 and the deny on row 5 already cover the moments they accompany.                                                                                                                                                              |

The card's U-1 named rows 1, 2, 3, 4, 5 and 9. Rows 6, 7, 8, 10 and 11 were added because §3
shows they are the claims the most common executor shape actually makes, or the ways around the
gate.

### 5.2 The judgement

One function decides every intercepted claim, from the ledger (§6) and the check (§7):

| Rule | When                                                                             | Verdict       | Gate answer                                                                                                         |
| ---- | -------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------- |
| A    | The ledger holds no edit                                                         | `not-author`  | pass untouched                                                                                                      |
| B    | A check run is newer than the last edit and was green                            | `green`       | pass with a receipt note                                                                                            |
| C    | A check run is newer than the last edit and was red                              | `red`         | **deny**, with the run's output tail; nothing re-runs                                                               |
| D    | No run covers the last edit and no check resolves                                | `no-check`    | pass with "no runnable check is configured; this claim is unverified"                                               |
| E    | No run covers the last edit, mode is `annotate`, or this is a `tool.check` query | `stale`       | pass with "no check ran since the last edit (…). Run `<cmd>`."                                                      |
| F    | No run covers the last edit and mode is `enforce`: the gate runs the check (§8)  | `green`/`red` | as B or C, the run recorded as `by: 'gate'`                                                                         |
| G    | The gate's own run could not finish (timeout, spawn failure)                     | `unrun`       | **deny**: "the gate could not run `<cmd>` (…). Run it yourself with Bash; a green run after your last edit counts." |

Rule G denies rather than passes. The session can always settle it by running the check itself,
and that run becomes the receipt (rule B). Failing open there would turn every slow suite into a
silent bypass. A hook that **throws** is different: it fails open (§11.2).

The deny reason always starts with `[verify-gate]`, names the claim, the command and what to do
next, and carries at most 40 lines or 3,000 characters of output (§8.4).

## 6. "Ran since the last edit", against the session's own log (U-3)

### 6.1 The ledger

The gate keeps one value per session in `$.state` (`harnu-verify-gate.ledger`):

```ts
type Ledger = { seq: number; lastEditSeq: number; lastEdit: string; lastCheck: CheckRun | null }
type CheckRun = {
  seq: number
  command: string
  ok: boolean
  by: 'session' | 'gate'
  at: number
  tail: string
}
```

Every observed tool call increments `seq`. An edit sets `lastEditSeq = seq`. A check run sets
`lastCheck.seq = seq`. "The check ran since the last edit" is exactly
`lastCheck !== null && lastCheck.seq > lastEditSeq`. The order comes from a counter, not from
clock time, so two calls in the same millisecond still order correctly.

### 6.2 What counts as an edit, a check, or neither

The ledger is fed by `classic.PostToolUse` (the call ran) and `classic.PostToolUseFailure` (it
failed), for these tools:

| Finished call                                                                 | Counts as                                                                                                                                                 |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Edit`, `Write`, `NotebookEdit`, succeeded                                    | an edit (`lastEdit = "<tool> <path>"`)                                                                                                                    |
| the same, failed                                                              | nothing (the tree did not change)                                                                                                                         |
| `Bash` whose command contains the resolved check                              | a check run: `ok` is true on `PostToolUse`, false on `PostToolUseFailure`                                                                                 |
| `Bash` whose every `&&`/`\|\|`/`;`/`\|` segment starts with a neutral command | nothing: `git status/log/diff/show/add/commit/push/fetch/rev-parse/rev-list/branch`, `gh`, `ls`, `cat`, `head`, `tail`, `wc`, `rg`, `grep`, `pwd`, `echo` |
| any other `Bash`                                                              | **an edit** (conservative: `sed -i`, `npm install`, a codegen script all change the tree)                                                                 |

A check run with `run_in_background` reports before the command finishes. W1 ignores a Bash
call whose `tool_response.backgroundTaskId` is set (the field is in the Bash result type,
TYPES:20360-20400). The prototype does not do this yet (01-prototype §Gaps).

Choices worth stating:

- **"Contains" is deliberately loose.** `npm run typecheck && npx vitest run 2>&1 | tail -40`
  counts as the check. A command that only _mentions_ the check (`echo "npm run typecheck"`) would
  count too. That is a forgery the model has to choose to write. It is not the honest mistake
  the gate exists for (N4).
- **A commit is not an edit.** A green run, then `git commit`, then the claim, does not re-run
  (P-K "an edit after the check makes it stale; neutral git commands do not").
- **Subagents count.** An edit a subagent makes changes the same tree. The classic events fire
  for subagent calls too. That is assumption **A3**: P4 showed a subagent's `Write` landing, but
  did not assert that the gate's ledger saw it.
- **The check outcome is the tool's error flag.** The Bash result type has no exit code field
  (TYPES:20360-20400). A non-zero exit reaches `PostToolUseFailure`, which is assumption **A2**.
  The kit can only show the mapping, not the engine's routing.

### 6.3 Lifetime: reload, compaction, resume, clear

| Event                      | Ledger                                                                                                                                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hot reload of the mod      | Kept. `$.state` is the host's (REF:118).                                                                                                                                                                                                                    |
| Compaction                 | Kept. Same process, same session.                                                                                                                                                                                                                           |
| `--resume` (a new process) | **Assumed lost (A4).** W1 seeds the ledger on `classic.SessionStart` with `source: 'resume'` as `lastEditSeq: 1, lastEdit: '(edits before resume are unknown)'`, so the first claim after a resume runs the check. Failing closed here costs one check run. |
| `/clear`                   | Same seeding (`source: 'clear'`). The tree did not change, but the gate cannot know what the cleared conversation did.                                                                                                                                      |

## 7. Where the check comes from (U-2)

### 7.1 What exists today, and why none of it is a command

| Candidate                                              | What it holds today                                                                                                                                                                                                                                                                     | Usable as the command?                                                                                                                               |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mission step `verification`                            | A level: `existence \| verifier \| human` (MC:76-95, schema 205-226). No `verify`, `command` or `check` field on a step or a mission.                                                                                                                                                   | No. It says _who_ proves the step, not _how_.                                                                                                        |
| Card AC lines `— verify: test\|visual\|manual\|review` | A kind, by skill convention only (`resources/skills/skills/orchestrate-delivery/SKILL.md:114`). Nothing in `src/` parses `verify:`. The only AC parser reads `{ text, checked }` (`src/renderer/src/lib/card-detail.ts:138`). ADR-0010's per-AC state is design-only (T216 S1:3).       | No. It says _which kind_ of evidence, not a command. Useful as a filter (§7.3).                                                                      |
| `WORKTREE.md`                                          | Provisioning: `dir`, `from`, `seed`, `setup`, `create`, `remove`, `boot`, `ephemeral` (`worktree-manifest.ts:139-148`). Unknown keys are dropped with a warning (:266-268). This repo's own file says in prose that `npm run typecheck` is "the go/no-go signal" (`WORKTREE.md:31-34`). | Not yet. It is the natural home: committed, per repo, already holds POSIX commands Harnu runs (ADR-0005), already has a `WORKTREE.local.md` overlay. |
| `package.json` scripts                                 | `test`, `typecheck`, `lint`, `format:check` (`package.json:28-52`)                                                                                                                                                                                                                      | Only by guessing. A guess would run `npm test` in a repo whose real gate is something else.                                                          |
| A new Mission field                                    | None. Executors of the most common shape cannot read the mission (§3).                                                                                                                                                                                                                  | Possible later, per step (Q3). Not v1.                                                                                                               |

### 7.2 Decision: a `verify:` key in `WORKTREE.md`

```yaml
---
dir: .claude/worktrees/{slug}
from: main
setup:
  - npm ci
verify:
  - npm run typecheck
  - npx vitest run
---
```

- One string, or a list of strings joined with `&&` in order. Each item is a POSIX command line,
  the same contract as `setup` (ADR-0005), run with `sh -c`.
- `WORKTREE.local.md` overrides it, the same overlay rule as the other keys
  (`worktree-manifest.ts:44-65`), so a machine without a tool can narrow its check locally.
- The gate reads the file itself from the session root (`$.fs.read('WORKTREE.md')`), with no host
  round-trip, so it also works outside Harnu. Fallback: the mod's `check` userConfig option.
  Neither gives a command → rule D (no check).
- **Dependency D-1 (server, S):** add `verify` to `KNOWN_KEYS` and to `ResolvedManifest`, so that
  Harnu stops warning "unknown key … ignored" and the worktree-manifest skill can author it. The
  gate does not need Harnu to _resolve_ it. Only the warning has to go, and the parse rules have to
  match (W0 checks the mod's parser against `worktree-manifest.ts` on the same fixtures).
- The prototype parses only `WORKTREE.md`, not the `.local.md` overlay or `.claude/worktree.md`.
  W1 reads all three, in the resolver's order.

### 7.3 Which claims a check applies to

v1 applies the one repo-wide check to every gated claim. AC kinds become a filter in W3, once the
gate can read the claimed card (T447's `boardGet`, T447/01-contract:188): a card whose ACs are all
`visual`, `manual` or `review` has nothing runnable, so its claim gets rule D's note rather than a
check that proves nothing about it. Any `test` AC keeps the check.

## 8. Running it safely (U-3)

### 8.1 What runs, where, and who wrote it

- **Argv:** `['sh', '-c', <command>]` through `$.process.run`, which has no shell of its own
  (TYPES:3499-3515). The command comes **only** from the committed `WORKTREE.md`, its local
  overlay, or the operator's userConfig. It never comes from the model's arguments, a card body,
  or a Mission field an agent can write. Its trust level is the same as `setup`, which Harnu
  already runs when it creates a worktree.
- **Working directory:** `$.session.root()`, the session's project root. For a session Harnu
  spawns in a worktree, that is the worktree. A shell `cd` inside the session does not move it
  (TYPES:2776-2783), so the model cannot point the check at another directory.
- **Never destructive.** Before running, W1 refuses a resolved command that matches a fixed
  denylist: `rm -rf`, `git reset --hard`, `git clean`, `git checkout --`, `git push`,
  `gh pr merge`, `| sh`, `| bash`, `curl`/`wget` piped to a shell. A refused command is treated as
  rule D plus a one-time toast naming the line. This is a seat belt for a mistyped manifest, not a
  sandbox. The real guard is that only a committed file or the operator writes the command.
- **Environment:** the session's own, plus `CI=1` so test runners take their non-interactive
  path. No stdin, so a prompt in the check fails fast instead of hanging until the timeout.
- **Concurrency:** one run at a time per session. W1 keeps the in-flight promise in a module
  variable keyed by `lastEditSeq`, so two claims racing on the same tree share one run. A reload
  drops the variable, which costs at most one extra run.

### 8.2 Timeouts, measured

`$.process.run` defaults to 30 s and caps at 10 minutes (TYPES:8014-8017). The gate's default is
**300 s**, configurable up to 600.

**Measured on this machine** on 2026-10-09: 20 cores (`nproc`), this worktree at `cb7fb58`, warm
caches, `/usr/bin/time -f %e`:

| Command             | Wall time | Exit                                                                                                                                             |
| ------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run typecheck` | 14.93 s   | 0                                                                                                                                                |
| `npx vitest run`    | 38.42 s   | 1. 630 files, 12,515 tests; one failure in `tests/usage-poller.test.ts` ("probes are never injected"), which this docs-only branch did not touch |

So this repo's likely `verify` (`typecheck && vitest`) takes about 53 s here. 300 s leaves about
5.6× headroom for a cold cache or a slower machine. A run past the timeout is rule G: denied with
"run it yourself", and the session's own Bash call (default 2 min, 10 min max, per the Bash tool's
`timeout` parameter, TYPES:16188-16193) becomes the receipt.

The 10 s hook budget does not bound the run: the budget clock stops during any `$` call
(TYPES:5089-5104). P3 ran a 15 s check inside `tool.check` and the deny arrived (31 s end to end,
including the model's own turn).

### 8.3 What the claim waits on

A gated claim blocks until the check finishes. That is the point: the claim is not made until the
check ran. The cost is paid once per edit cycle, because a later claim reuses the receipt (rule B),
and only by authors.

### 8.4 Output capture and truncation

`$.process.run` keeps the first 4 MiB of each stream and flags the cut (TYPES:8026-8054). The gate
keeps a **tail**: the last 40 lines, then the last 3,000 characters of those. Compiler and
test-runner failures end with the summary, so the tail is the useful end. The tail goes into the
deny reason, into the ledger, and (W3) into the `mission_log` note, which allows 8,000 characters
(TC:1524).

### 8.5 When nothing is runnable

| Situation                                                       | Result                                                                                 |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| No `verify:` key and no userConfig `check`                      | Rule D: pass, with a note that the claim is unverified.                                |
| The claimed card's ACs are only `visual`/`manual`/`review` (W3) | Rule D's note, naming the kinds: the delivery-verifier or the operator owns those ACs. |
| The resolved command hits the denylist                          | Rule D, plus a toast naming the refused line.                                          |
| The command cannot start (`sh` missing, cwd gone)               | Rule G: deny, "run it yourself".                                                       |

## 9. Relation to independent verification (U-4)

### 9.1 What the gate is, and is not

The gate is a **self-check** by the session that wrote the code, judged from that session's own
log. It answers one question: did the repo's check run green on this tree after the last edit?

It is not verification in Harnu's sense:

- It never calls `mission_verify_step`, so it never produces a `verified` or `self-verified` proof.
  T447 left that verb out of its noun for the same reason: "a mod inside an executor would launder
  self-verification" (T447/03-security:28).
- It never ticks a check, never moves a card to `done` (no verb can, TC:961), never raises a close.
- The delivery-verifier still grades every AC from evidence, blind to the executor's report
  (DV:17-22, 45-62), and still records with `mission_verify_step` from a session that built none
  of the steps (DV:224-233, TH:4455-4466).

### 9.2 How it complements the verifier

The verifier's deterministic table already has "Tests ran after the last edit | test-run
timestamp vs. last commit time | a 'lucky pass'" (DV:70-79). The gate moves that check to the
moment of the claim, inside the session, where the edit log is exact and not reconstructed from
timestamps. A claim that reaches the verifier has therefore already passed one green run. The
verifier spends its time on what only it can judge: scope, AC meaning, the UI capture.

The receipt is a **hint, never proof**. The verifier's own rule stands: "An executor's own tick is
recorded as `by: executor` and never counted" (DV:202-203). The gate's receipt is the same kind of
evidence, machine-written instead of model-written. A verifier may use it to skip a re-run only
when the receipt's HEAD sha equals the PR head. It still runs the gate command itself when they
differ or the receipt is missing.

### 9.3 What it records, and where

| Where                              | What                                                                                                                                                                                                                                        | When                                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| The claim's own result             | The deny reason (red, unrunnable) or the `context` note (green, stale, no check), so the model and the transcript see it                                                                                                                    | v1 (W1), every intercepted claim                                                                                       |
| The session's `SendMessage` report | One appended receipt line (§5.1 row 7). It reaches the orchestrator, which records what it needs with `mission_log` (ADR-0015:24-32)                                                                                                        | W2                                                                                                                     |
| The Mission Log                    | `mission_log({ missionId, stepId, note })`, note = `verify-gate · green\|red\|unverified · \`<cmd>\` · HEAD <sha7> · by session\|gate` and, when red, the tail. Format fixed so a verifier can grep it                                      | W3, through T447's `$.harnu.missionLog` (T447/01-contract:205-209), only when the claim named a mission (rows 1, 4, 8) |
| The step's blockers                | On red: `missionBlockerSet({ stepId, owner: 'agent', reason: 'verify-gate: <cmd> failed after the last edit', unblocks: 'a green run of <cmd> after the last edit' })`. On the next green claim: `missionBlockerClear` with the same reason | W3, same channel. This is the "blocked state" the card asks for, as a flag, which is what a blocker is (TC:1533)       |

Why W3 waits for T447. The gate could call `$.mcp.call('harnu', 'mission_log', …)` today. Two
things argue against it. T447's guard will deny every direct `$.mcp.call` into `harnu` from any
mod but `harnu` itself (T447/03-security:50-56), so a direct call would break the day T447 ships.
And the noun already scopes mission writes to the caller's own steps (T447/03-security:23), which
is the scope the gate needs. So the gate declares `harnu` under `dependencies` and records through
the noun. Before T447 ships, or where the noun answers `NO_MCP` (an MCP-less child), the gate still
denies and annotates (W1, W2). It just writes nothing into the Mission.

## 10. Packaging (C-3)

**Decision: a separate mod, `harnu-verify-gate`, bundled by Harnu and staged the same way as the
companion. Harnu's main process owns the on/off preference and the `verify:` key. The mod owns
detection, the run, and the answer.** [`ADR-draft.md`](ADR-draft.md) records the decision and the
alternatives.

| Option                                                      | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inside `harnu-companion` (`resources/companion/`)           | **Rejected.** The gate needs `$.process.run` (forbidden, SEC-9a), would want `$.mcp.call` (SEC-9b) and needs a Bash hook. All three are enforced statically (`scripts/ci/api-surface-scan.mjs:133-175`, `tests/companion/api-surface.test.ts:96-119`). The companion's `tool.call` surface is closed to two matchers (MOD-3, T389/00-master:524), and its `/^mcp__(harnu\|capy)__/` registration belongs to P2W5 (T389/P2W5-mcp-attribution.md:84-105). |
| Companion asks the host to run the check (a new `ask` kind) | **Rejected for v1.** No ask kind is registered: `registerAskKind` has no caller (`src/main/companion/host-core.ts:113, :498`; `server.ts:563-564` answers `FEATURE_DISABLED`). Ask tranches are ≤20 s (MOD-5), while this repo's check takes ~53 s. MOD-5 forbids an ask when `isInteractive` is false. It would also be dead outside Harnu.                                                                                                            |
| Main process only (no mod)                                  | **Rejected.** Main sees neither the session's edits nor its Bash runs. Harnu installs no `PostToolUse` hook (`src/main/hook-installer.ts:39-51`), and the MCP transport has no per-session identity (TC:1312). The server cannot tell an author's claim from an orchestrator's.                                                                                                                                                                         |
| Inside T447's `harnu` mod                                   | **Rejected.** That mod's job is the noun, and its guard posture (deny every direct `mcp.call`) should not gain a process runner.                                                                                                                                                                                                                                                                                                                        |
| **A separate bundled mod**                                  | **Chosen.** It is free of the companion's SEC-9 floor because it is a different mod with its own Mods-tab disclosure (§11.3). It works outside Harnu as a plain plugin. It reaches the Mission later through T447's noun, not around it.                                                                                                                                                                                                                |

**Staging.** Like the companion (ADR-0018 D1, `src/main/companion/staging-core.ts:14, :77-86`):
an immutable versioned copy under `<userData>/verify-gate/<modVersion>/harnu-verify-gate/`, passed
as one more `--plugin-dir` after the companion's, by the same `withOptionArgs` injector
(`pty.ts:855-857`). The per-session mode travels as one env var, `HARNU_VERIFY_GATE=off|annotate|enforce`,
which the mod reads with a literal `$.env.get` (the companion's rule, `docs/dev/companion-mod.md:48-61`).
Its own surface manifest and CLI ceiling follow the companion's `api-surface.json` pattern
(`resources/companion/api-surface.json:1-46`), checked by the existing `scripts/ci/mod-step.mjs`.

**Which sessions get it.** Every PTY session Harnu spawns, in the four shapes of §3, except:

- Scheduler ticks. An `observe` tick has no Bash and no Edit, so it is never an author; an `act`
  tick is Q5. Note that T447 found ticks inherit Harnu's process-env `CLAUDE_CODE_PLUGIN_DIRS`
  (T447 card, round 3). Staging by `--plugin-dir` per spawn, not by process env, keeps the gate out
  of ticks unless Q5 decides otherwise.
- T245 read-only review companions. They are read-only by construction (`pty.ts:790-810`), so they
  are never authors.

**Outside Harnu.** The mod is a plain plugin with `userConfig` (`mode`, `check`,
`timeoutSeconds`). A person installs it with `/plugin install harnu-verify-gate --marketplace
<owner>/<repo>`, or through an "Also outside Harnu" switch that adds it to
`env.CLAUDE_CODE_PLUGIN_DIRS`, as P4W3 does for the companion
(`src/main/companion/external-install-core.ts:6, :13`). Outside Harnu it gates `gh pr create/ready`
(row 5) and annotates replies (row 9). Rows 1-4 never fire there, because there is no Harnu MCP
server. Rows 7 and 8 behave the same inside and out.

## 11. Control and failure (C-4)

### 11.1 Switches and defaults

| Switch                                                                                                                  | Values                             | Default                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Settings → General → Integrations, "Verify before done", global, beside the "Harnu mod" switch (`CHANGELOG.md:160-163`) | Off · Annotate · Enforce           | **Enforce** for sessions Harnu spawns for an agent (`spawnedBy: 'agent'`, board/manifest or MCP). **Annotate** for the operator's own sessions. |
| Folder context menu, "Verify before done"                                                                               | Inherit · Off · Annotate · Enforce | Inherit                                                                                                                                         |
| Outside Harnu: the mod's `mode` userConfig                                                                              | `off` · `annotate` · `enforce`     | `enforce`                                                                                                                                       |

The pref is stored the way the companion's feature keys are (`registerPrefsKey`,
`src/main/companion/companion-prefs.ts:211-229`), with a per-folder field in `projects.json`
beside `companionActive` (`src/main/user-projects.ts:75`). It is resolved at spawn into
`HARNU_VERIFY_GATE`. A change applies to the **next** session. A running session keeps its mode,
because the mod reads the env var once (Q7 asks whether a live switch is worth a command-channel
message).

Why the operator's own sessions default to annotate: the operator is present and can read the
note. A refused `gh pr create` in the middle of their own flow is friction, not safety. An
unattended executor is the case the gate exists for.

### 11.2 Failure: fail-open, through `.catch`, with three exceptions

Every hook is registered with `.catch(($, e, next) => next(e))` (P-K validate lists each one "with
`.catch`"). When the gate itself throws or overruns, the handler replays `next` if it already
ran, and runs it if not, so the claim proceeds as if the gate were absent (TYPES:3931-3940,
REF:79). Reasons:

- The gate is a speed bump, not a boundary (N4). A broken gate that blocks every claim would
  wedge an unattended executor, and nobody would be there to see it.
- Independent verification (§9) still runs downstream, so a missed gate costs a lucky pass that
  the verifier can still catch, not a wrong `verified`.

The three exceptions are verdicts, not failures:

1. **Red** (rule C/F) denies. That is the gate working.
2. **Unrunnable** (rule G) denies, because the session can settle it itself.
3. **Resume/clear** seeds the ledger as edited (§6.3), so the first claim after a resume runs the
   check.

A failed hook is visible: the engine writes one dim transcript line in a session that
hot-reloads, and a debug-log line in every session (REF:78-81). W1 also bumps a per-session
`failures` counter in the ledger, which Q8 proposes to surface in Settings → Mods.

### 11.3 What Settings → Mods shows

Chips come from `deriveCapabilities` (`src/main/mods-audit-core.ts:369-393`), fed by `claude plugin
validate`'s notes (`mods-audit.ts:443-455`). For the prototype's validate output (01-prototype
§P-K), plus W1's `$.env.get`:

| Chip          | Why it lights                                      | Rule (`mods-audit-core.ts`) |
| ------------- | -------------------------------------------------- | --------------------------- |
| `process`     | `$.process.run` (via `judge`)                      | :376                        |
| `files`       | `$.fs.read` (via `resolveCheck`)                   | :378                        |
| `tool-calls`  | hooks `tool.call` (MCP verbs, `SendMessage` in W2) | :381                        |
| `permissions` | hooks `tool.check` (Bash)                          | :382                        |
| `env`         | reads `HARNU_VERIFY_GATE` (W1)                     | :388                        |

Chips that do **not** light: `mcp`, because the gate makes no `$.mcp.call`, and a noun call
(`$.harnu.missionLog`, W3) is not an `mcp.call` op. `other-mods`, because it hooks no
`http/env/store/state/fs` event; it _calls_ `state`, which is not hooking. `gate`, `prompts`,
`model`, `terminal` and `opaque` stay off too: the matchers are literal strings with no `?`, which
is why §5.1 lists `mcp__harnu__…` and `mcp__capy__…` as two strings rather than one RegExp. No
"gating hook without .catch" warning appears (`:233-245`), because every gate has one.

`pickPermissionHookers` (`mods-audit-core.ts:748-764`) will list the gate as a mod that decides
permissions or rewrites tool calls. That is accurate. The user doc says why (C-6).

## 12. Risks

| Id  | Risk                                                                                                              | Severity | Handling                                                                                                                      |
| --- | ----------------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------- |
| R1  | A model forges a receipt (`echo npm run typecheck`) or claims through an unhooked path (a `curl` to the MCP port) | Medium   | Stated non-goal (N4). The verifier never counts the receipt as proof (§9.2).                                                  |
| R2  | Another mod calls `mission_update_step` directly before T447 ships                                                | Low      | §5.1 row 10. Closed by T447's guard.                                                                                          |
| R3  | Neutral-command list too narrow: a harmless Bash call marks the tree edited, so an extra check runs               | Low      | Costs one run; the list is data and grows with evidence.                                                                      |
| R4  | Neutral list too wide: a tree-changing command is treated as neutral, so a stale green receipt passes             | Medium   | The list holds read-only and git-plumbing verbs only. `git checkout`/`git stash`/`git pull` are deliberately **not** neutral. |
| R5  | A slow suite makes every claim wait                                                                               | Low      | Once per edit cycle (§8.3); the timeout is configurable; rule G hands the run back.                                           |
| R6  | Issue #92533 is fixed and a later build changes the Bash shape                                                    | Low      | The gate never registers `tool.call` on Bash, so a fix changes nothing. A static test pins it, as for the companion.          |
| R7  | `classic.PostToolUse` stops firing for subagents (A3) or for failures (A2) on a later build                       | Medium   | W0 probes both live on the pinned CLI; the CLI ceiling forces annotate above the tested build (§13 W1).                       |

## 13. Implementation outline (C-6)

Dependency order. S ≈ ≤ 1 day, M ≈ 2-3 days, L ≈ a week.

| Wave | Size | Content                                                                                                                                                                                                                                                                                                              | Depends on                                   |
| ---- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| W0   | S    | Spike on the pinned CLI: assumptions A1-A6 (§15) live; the mod's `verify:` parser against `worktree-manifest.ts` fixtures; re-read the regenerated types for every cite in §4.                                                                                                                                       | —                                            |
| D-1  | S    | `worktree-manifest.ts`: `verify` in `KNOWN_KEYS` and `ResolvedManifest`, overlay rules, tests. The worktree-manifest skill learns to author it. This repo's own `WORKTREE.md` gains `verify: [npm run typecheck, npx vitest run]`.                                                                                   | —                                            |
| W1   | M    | The mod, rows 1-5 and 9: the prototype plus the background-run rule (§6.2), the resume/clear seeding (§6.3), `.local.md` and `.claude/worktree.md`, the denylist, `CI=1`, single-flight, `HARNU_VERIFY_GATE`, its `api-surface.json`, CLI ceiling, a static "no Bash `tool.call`" test, and `mod-step.mjs` coverage. | W0, D-1                                      |
| W2   | M    | Host side: staging and `--plugin-dir` injection, the global and per-folder switch and its Settings UI, then row 7 (the `SendMessage` receipt). Renderer UI follows `design.md` (a three-way segmented control, as the folder menu's existing toggles).                                                               | W1                                           |
| W3   | M    | Mission writes through T447's noun: `dependencies: ['harnu']`, the `mission_log` receipt, the step blocker raise and clear, row 8 (noun events), the AC-kind filter through `boardGet`.                                                                                                                              | W1, T447 (noun waves incl. D-A child lookup) |
| W4   | S    | "Outside Harnu" switch and marketplace entry, like P4W3.                                                                                                                                                                                                                                                             | W2                                           |

**Contracts the implementation owes:**

- **`CHANGELOG.md`**: W1-W4 each add a dated entry (W1 and W3 under "Added", W2 under "Added"
  for the switch).
- **`docs/harnu-features.md` + marker bump**: W2 is agent-facing. The session must learn that its
  completion claims are gated, what a `[verify-gate]` refusal means and how to clear it (run the
  check, then claim again), and that a red result is to be reported, not hidden. W3 adds the
  receipt line format and the blocker. No new MCP verb is added, so the awareness CI gate will not
  force it. The doc update is owed under the "UI affordance / grant semantics" clause anyway.
- **`docs/user/`**: W2 adds a section on what the gate does, the three modes, the defaults, how to
  write `verify:` in `WORKTREE.md`, and what the Mods tab chips mean. W4 covers outside Harnu.
- **`design.md` + both i18n locales (`en.json`, `pt-BR.json`)**: W2's switch, its labels and its
  help line. The section is §6 Components, Settings dialog and folder context menu.
- **ADR**: this unit's `ADR-draft.md` is numbered at merge.

## 14. Relation to T389 and T447 (C-2)

Status was checked against the code on 2026-10-09 (`git log` at `cb7fb58`).

| Work                                              | Status (code)                                                                                                                                                | Relation                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T389 P1W1-P1W6, P2W1 (shadow), P4W1 A+B, P4W3     | **Shipped** (commit `7446534`; `CHANGELOG.md:151-182`)                                                                                                       | **Builds on**: staging and `--plugin-dir` injection (P1W2), the CLI-ceiling pattern (P1W2), prefs (P1W4), the Mods tab (P4W1) that discloses the gate, the outside-Harnu switch pattern (P4W3). It duplicates none of them: it reuses them for a second mod.                                                                                                           |
| T389 P2W4, live contract and in-process guard     | Specified, **not implemented**: no `guard-core`, no `tool.call` registration; the legacy `guard.mjs` still enforces (`src/main/orchestrator-guard.ts:46-47`) | **Overlaps** as a pattern only. P2W4 denies an armed orchestrator's edits; the gate denies an author's claims. Different trigger, different deny. Same fail-open posture (T389/P2W4:263-283). An orchestrator is never an author, so the two never fire on the same session for the same reason.                                                                       |
| T389 P2W5, MCP caller attribution                 | Specified, **not implemented**                                                                                                                               | **Overlaps on the matcher.** P2W5 rewrites `mcp__harnu__*` input to stamp the caller, inside the companion. The gate denies before `next` and never rewrites MCP input, so P2W5's auto-mode refusal problem (T389/P2W5:93, :110-118) cannot arise from the gate. Two mods may both hook the same tool; MOD-4's one-registration rule is the companion's internal rule. |
| T389 P3W1 approval hold; P3W2 structured Sentinel | Specified, **not implemented** (insertion-point comments at `resources/companion/hooks/register.ts:1246, :1273`)                                             | **Extends the precedent.** P3W2 is the precedent for a deny at `tool.check` on a watched tool (T389/P3W2:45-56, :204-237). The gate follows the same shape for Bash, inside its own mod. P3W1 holds permission _dialogs_; the gate never touches `classic.PermissionRequest`.                                                                                          |
| T389 P4W2 terminal band; P4W5 compaction digest   | Specified, **not implemented**                                                                                                                               | No overlap in v1. A band showing "check green since last edit" is a natural P4W2 addition (Q9).                                                                                                                                                                                                                                                                        |
| T447 `$.harnu` noun                               | **Spec merged** (PR #41, commit `9142876`), **noun not implemented**: no `harnu` mod in `resources/`, no `engine.create` hook in `src/` or `resources/`      | **Depends on it for W3**: `missionLog`, `missionBlockerSet`, `missionBlockerClear`, `boardGet`, and the noun events of row 8. Respects its guard: no direct `$.mcp.call('harnu', …)` (§9.3).                                                                                                                                                                           |
| Ideas 38, 55, 63, 67 (same cluster)               | Ideas only                                                                                                                                                   | 38 (an AC gate with a model fork) and 63 (verifier on PR open) are the **independent** side this spec stops short of (§9). 67 (red-before-green) reuses the ledger.                                                                                                                                                                                                    |

The card text said T447 was "PR #41, not merged". The commit log shows it merged as `9142876`.
The noun itself is still unbuilt, which is the status that matters here.

## 15. Assumptions for the W0 spike

| Id  | Assumption                                                                                                       | Why it matters                      | How W0 checks it                                                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| A1  | `tool.call` on `mcp__harnu__*` with a deny works in a live Harnu session, as in the kit                          | Rows 1-4                            | Shown live against a stand-in server (P5, P6). Left: a real Harnu session, its server and "Ask before agent actions". |
| A2  | A Bash call that exits non-zero raises `classic.PostToolUseFailure`, not `PostToolUse`                           | A red session run must count red    | Live: `false` as the check, then a claim.                                                                             |
| A3  | Classic tool events fire for a subagent's calls in the parent's mod, and `$.state` is the parent session's there | Subagent edits must stale a receipt | Live: an `Agent` that edits, then a claim with a prior green receipt.                                                 |
| A4  | `$.state` does not survive `--resume` (a new process)                                                            | §6.3 seeding                        | Live: green receipt, quit, resume, claim.                                                                             |
| A5  | `turn.complete`'s returned text shows beneath the answer in the terminal and in the desktop surface              | Row 9 is visible                    | Live, both surfaces.                                                                                                  |
| A6  | A `context` note on an MCP tool's result reaches the model in a Harnu session                                    | Rows 1-2 green receipt              | Shown live against a stand-in server (P6). Left: Harnu's own server.                                                  |

## 16. Open questions (C-7)

| Id  | Question                                                                                                                                                                                                   | Who decides                        | Proposal                                                                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------- |
| Q1  | Default mode for the operator's own sessions: annotate (proposed) or enforce?                                                                                                                              | Operator                           | Annotate. Revisit after a month of enforce data from agent sessions.              |
| Q2  | Should D-1's `verify:` also run at worktree creation as a post-`setup` smoke check?                                                                                                                        | Operator, with WORKTREE owner      | No. Keep it the done gate; creation stays fast.                                   |
| Q3  | Per-step or per-AC commands (a Mission step `check` field, or `verify: test \`<cmd>\`` on an AC line)?                                                                                                     | Operator, with T216/ADR-0010 owner | Not before ADR-0010's AC parser exists. One repo check covers the measured need.  |
| Q4  | Should an orchestrator's `proof: 'claimed'` on behalf of a child be gated on the child's receipt in the Mission Log (W3 data)?                                                                             | Operator, with mission skill owner | Yes, as annotate-only, after W3 ships the receipt format.                         |
| Q5  | Stage the gate into Scheduler `act` ticks?                                                                                                                                                                 | Operator                           | Yes, enforce: an unattended act tick is the riskiest author.                      |
| Q6  | Bash claims cannot carry a green note (`tool.check` answers carry no `context`). Add a `classic.PostToolUse` `additionalContext` on the `gh pr` call for symmetry?                                         | Implementer (W1)                   | Yes, cheap: PostToolUse allows `additionalContext` (TYPES:1368).                  |
| Q7  | Live mode switch for running sessions over the command channel?                                                                                                                                            | Operator                           | No for v1; next session is fine.                                                  |
| Q8  | Surface the gate's own failure count in Settings → Mods ("did", not "can", idea 123)?                                                                                                                      | Operator, with P4W1 owner          | Yes, once idea 123's "did" column exists.                                         |
| Q9  | Show "check: green since last edit / stale" in P4W2's band when that ships?                                                                                                                                | P4W2 owner                         | Yes, read from the ledger.                                                        |
| Q10 | Use `$.model.classify(answer, ['claims-done', 'progress', 'question'])` instead of the word list for row 9, to cut false positives? It adds one small-model request per stale answer and the `model` chip. | Operator                           | Not in v1. Measure the word list's false-positive rate on real transcripts first. |

## 17. Acceptance-criteria traceability

| AC  | Where                                                                                                                  |
| --- | ---------------------------------------------------------------------------------------------------------------------- |
| U-1 | §3, §5.1 (11 signals, each with a decision), §5.2                                                                      |
| U-2 | §7 (sources compared, decision, D-1 named)                                                                             |
| U-3 | §6 (the ledger, against the session's own log), §8 (argv, cwd, denylist, timeouts measured, capture, nothing runnable) |
| U-4 | §9                                                                                                                     |
| C-1 | §4 (every mechanism cited and, where the design hinges on it, run: P-K, P1-P6)                                         |
| C-2 | §14                                                                                                                    |
| C-3 | §10, ADR-draft                                                                                                         |
| C-4 | §11                                                                                                                    |
| C-5 | [`01-prototype.md`](01-prototype.md)                                                                                   |
| C-6 | §13                                                                                                                    |
| C-7 | §16                                                                                                                    |
| C-8 | English throughout; neutral vocabulary; prettier and `tests/no-client-identifiers.test.ts` (in the report)             |
