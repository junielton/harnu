# T452 — Prototype: `harnu-verify-gate` (C-5)

**Part of:** [`00-spec.md`](00-spec.md) · **Card:** T452 · **Status:** specified (not implemented) ·
**Round 4**

The minimal hooks module for the core mechanism:

- the ledger and `classifyBash`, an allowlist (spec §6.2);
- the judgement (§5.2);
- the policy: Harnu's spawn env bound to the session root, every settings source and their merge
  refused when they name `HARNU_VERIFY_*`, or the person's userConfig outside Harnu (§7.2, §7.6);
- the session's own permission check before each part (§7.6 a, §8.1);
- the run of approved parts through `$.process.spawn`, with its timeout and Esc (§8);
- the claims of §5.1 rows 1, 2, 5, 7, 9 and 12.

The files were written in the session scratchpad, never under `src/` or `resources/`, and checked
on 2026-10-09. What W1 still owes is listed under [Gaps](#gaps-against-the-spec).

Versions: types written by Claude Code **2.1.295**'s `plugin-authoring` skill; `claude` reported
`2.1.296 (Claude Code)`; TypeScript `5.9.3` from this repo's `node_modules`. Paths are shortened to
`<scratch>` (the session scratchpad) and `<skill>` (the skill's folder).

## P-K — `claude plugin validate`, `claude plugin test`, `tsc`

`claude plugin validate .`:

```
Validating plugin manifest: <scratch>/harnu-verify-gate/.claude-plugin/plugin.json

  ❯ types ./types/index.d.ts declares on $: nothing (no EngineInterface member)
  ❯ types ./types/index.d.ts declares state: harnu-verify-gate.ledger

Validating hooks: <scratch>/harnu-verify-gate/hooks/hooks.json

  ❯ ./register.ts hooks: classic.PostToolUse, classic.PostToolUseFailure, classic.SessionStart, tool.check{tool=Bash}, tool.call{tool=mcp__harnu__mission_update_step|mcp__capy__mission_update_step}, tool.call{tool=mcp__harnu__move_card|mcp__capy__move_card}, session.send, tool.call{tool=mcp__harnu__message_session|mcp__capy__message_session}, turn.complete
  ❯ ./register.ts gating hook with .catch: classic.PostToolUse
  ❯ ./register.ts gating hook with .catch: classic.PostToolUseFailure
  ❯ ./register.ts gating hook with .catch: classic.SessionStart
  ❯ ./register.ts gating hook with .catch: tool.check{tool=Bash}
  ❯ ./register.ts gating hook with .catch: tool.call{tool=mcp__harnu__mission_update_step|mcp__capy__mission_update_step}
  ❯ ./register.ts gating hook with .catch: tool.call{tool=mcp__harnu__move_card|mcp__capy__move_card}
  ❯ ./register.ts gating hook with .catch: session.send
  ❯ ./register.ts gating hook with .catch: tool.call{tool=mcp__harnu__message_session|mcp__capy__message_session}
  ❯ ./register.ts calls: $.clock.after (via runPart), $.clock.now (via record), $.env.get (via policy), $.process.spawn (via runPart), $.session.root (via policy, runPart), $.settings.read (via policy), $.state.get, $.state.set, $.tool.check (via permitted), $.ui.status (via judge)
  ❯ ./register.ts env writes: nothing
  ❯ ./register.ts env reads: HARNU_VERIFY_CMD, HARNU_VERIFY_GATE, HARNU_VERIFY_ROOT
  ❯ ./register.ts state writes: harnu-verify-gate.ledger
  ❯ ./register.ts state reads: harnu-verify-gate.ledger

✔ Validation passed
```

`claude plugin test .`:

```

tests/gate.test.ts:
(pass) a claim from a session that edited nothing passes untouched [34.36ms]
(pass) inside Harnu, a claim after an edit runs each approved part in order; green passes with a receipt [33.32ms]
(pass) a red part refuses the claim, says the gate ran it, stops there, and never reaches the verb [19.59ms]
(pass) the working tree cannot choose the command: nothing approved means nothing runs [17.76ms]
(pass) the session's own runs count part by part, as separate Bash calls: nothing reruns [20.70ms]
(pass) only the part the session did not run is run by the gate [20.41ms]
(pass) a focused run is no receipt and no edit; an unknown command is an edit [28.34ms]
(pass) the session's own red run refuses the claim without a rerun, and says who ran it [18.37ms]
(pass) an edit after a green check makes it stale; neutral git commands do not [25.46ms]
(pass) gh pr create: a query runs nothing; a draft is never gated; a red receipt is denied at tool.check [21.29ms]
(pass) move_card to review is gated, to backlog is not; the legacy capy name is gated too [29.54ms]
(pass) a part that outlives the timeout is stopped, recorded as nothing, and handed back to the session [532.32ms]
(pass) annotate mode lets a stale claim through with a warning and runs nothing [16.51ms]
(pass) off mode leaves even a red claim alone [15.29ms]
(pass) outside Harnu the default is annotate, and nothing runs [11.82ms]
(pass) outside Harnu, enforce runs only the userConfig check [13.30ms]
(pass) a resumed session is treated as edited: its first claim checks [17.26ms]
(pass) a completion report sent to another session carries the receipt line [16.65ms]
(pass) message_session asks for a re-send with the receipt line, and passes once it is there [23.10ms]
(pass) a "done" reply with no green check since the last edit is annotated [19.69ms]
(pass) `sh check.sh 2>&1 | tail -5` exiting 0 is no receipt: the gate runs the part itself [17.18ms]
(pass) `sh check.sh || true` exiting 0 is no receipt: the gate runs the part itself [17.36ms]
(pass) `sh check.sh; rm -r x` exiting 0 is no receipt: the gate runs the part itself [16.63ms]
(pass) `sh check.sh || echo failed` exiting 0 is no receipt: the gate runs the part itself [16.33ms]
(pass) `sh check.sh; echo done` exiting 0 is no receipt: the gate runs the part itself [16.75ms]
(pass) control: the bare part exiting 0 is a receipt; a later `; rm -r x` is an edit [21.34ms]
(pass) a write through `>` is an edit; `cd elsewhere && <part>` is no receipt and no edit [25.72ms]
(pass) a part this session's permissions would ask about is not run: the session runs it [13.90ms]
(pass) HARNU_VERIFY_* in the project settings sets Harnu's parts aside [12.11ms]
(pass) HARNU_VERIFY_* in the local settings sets Harnu's parts aside [12.18ms]
(pass) parts approved for another folder are set aside [13.16ms]
(pass) a receipt line copied from an earlier report does not count [17.53ms]
(pass) "sh check.sh && sh check.sh again & true" is no receipt: the gate runs the part itself [16.16ms]
(pass) "sh check.sh && sh check.sh again\ntrue" is no receipt: the gate runs the part itself [15.81ms]
(pass) "sh check.sh && sh check.sh again\r\ntrue" is no receipt: the gate runs the part itself [15.38ms]
(pass) "sh check.sh x & rm -rf src" is no receipt: the gate runs the part itself [21.59ms]
(pass) "sh check.sh $(rm -rf src)" is no receipt: the gate runs the part itself [17.73ms]
(pass) "sh check.sh `rm -rf src`" is no receipt: the gate runs the part itself [16.95ms]
(pass) "sh check.sh <(rm -rf src)" is no receipt: the gate runs the part itself [18.68ms]
(pass) "(sh check.sh)" is no receipt: the gate runs the part itself [16.92ms]
(pass) "{ sh check.sh; }" is no receipt: the gate runs the part itself [15.86ms]
(pass) "sh check.sh && true" is no receipt: the gate runs the part itself [26.78ms]
(pass) an honest shape with a trailing echo records nothing green: both parts re-run [19.24ms]
(pass) parts joined only by && with neutral commands are a receipt [15.02ms]
(pass) a narrower run of a part joined to the part is no receipt for either [17.31ms]
(pass) metacharacter lone &: `sh check.sh "&" true` is never a receipt [19.22ms]
(pass) metacharacter lone &: after a green receipt, `sh check.sh x "&"rm -rf src` is an edit [20.34ms]
(pass) metacharacter semicolon: `sh check.sh ";" true` is never a receipt [15.14ms]
(pass) metacharacter semicolon: after a green receipt, `sh check.sh x ";"rm -rf src` is an edit [23.16ms]
(pass) metacharacter pipe: `sh check.sh "|" true` is never a receipt [16.11ms]
(pass) metacharacter pipe: after a green receipt, `sh check.sh x "|"rm -rf src` is an edit [19.87ms]
(pass) metacharacter double pipe: `sh check.sh "||" true` is never a receipt [16.29ms]
(pass) metacharacter double pipe: after a green receipt, `sh check.sh x "||"rm -rf src` is an edit [23.35ms]
(pass) metacharacter triple &: `sh check.sh "&&&" true` is never a receipt [16.37ms]
(pass) metacharacter triple &: after a green receipt, `sh check.sh x "&&&"rm -rf src` is an edit [19.02ms]
(pass) metacharacter newline: `sh check.sh "\n" true` is never a receipt [18.51ms]
(pass) metacharacter newline: after a green receipt, `sh check.sh x "\n"rm -rf src` is an edit [18.79ms]
(pass) metacharacter carriage return: `sh check.sh "\r" true` is never a receipt [16.01ms]
(pass) metacharacter carriage return: after a green receipt, `sh check.sh x "\r"rm -rf src` is an edit [22.90ms]
(pass) metacharacter backtick: `sh check.sh "`" true` is never a receipt [15.81ms]
(pass) metacharacter backtick: after a green receipt, `sh check.sh x "`"rm -rf src` is an edit [18.79ms]
(pass) metacharacter command substitution: `sh check.sh "$(" true` is never a receipt [15.54ms]
(pass) metacharacter command substitution: after a green receipt, `sh check.sh x "$("rm -rf src` is an edit [23.56ms]
(pass) metacharacter process substitution: `sh check.sh "<(" true` is never a receipt [16.44ms]
(pass) metacharacter process substitution: after a green receipt, `sh check.sh x "<("rm -rf src` is an edit [18.68ms]
(pass) metacharacter open paren: `sh check.sh "(" true` is never a receipt [18.87ms]
(pass) metacharacter open paren: after a green receipt, `sh check.sh x "("rm -rf src` is an edit [17.99ms]
(pass) metacharacter close paren: `sh check.sh ")" true` is never a receipt [15.25ms]
(pass) metacharacter close paren: after a green receipt, `sh check.sh x ")"rm -rf src` is an edit [28.28ms]
(pass) metacharacter input redirect: `sh check.sh "<" true` is never a receipt [15.42ms]
(pass) metacharacter input redirect: after a green receipt, `sh check.sh x "<"rm -rf src` is an edit [18.03ms]
(pass) metacharacter output redirect: `sh check.sh ">" true` is never a receipt [15.69ms]
(pass) metacharacter output redirect: after a green receipt, `sh check.sh x ">"rm -rf src` is an edit [22.50ms]
(pass) metacharacter append redirect: `sh check.sh ">>" true` is never a receipt [14.17ms]
(pass) metacharacter append redirect: after a green receipt, `sh check.sh x ">>"rm -rf src` is an edit [21.30ms]
(pass) metacharacter open brace: `sh check.sh "{" true` is never a receipt [14.79ms]
(pass) metacharacter open brace: after a green receipt, `sh check.sh x "{"rm -rf src` is an edit [17.78ms]
(pass) metacharacter close brace: `sh check.sh "}" true` is never a receipt [20.11ms]
(pass) metacharacter close brace: after a green receipt, `sh check.sh x "}"rm -rf src` is an edit [29.25ms]
(pass) metacharacter backslash: `sh check.sh "\\" true` is never a receipt [29.00ms]
(pass) metacharacter backslash: after a green receipt, `sh check.sh x "\\"rm -rf src` is an edit [68.99ms]
(pass) metacharacter dollar sign: `sh check.sh "$" true` is never a receipt [18.70ms]
(pass) metacharacter dollar sign: after a green receipt, `sh check.sh x "$"rm -rf src` is an edit [21.27ms]
(pass) HARNU_VERIFY_* in the user settings sets Harnu's parts aside [12.61ms]
(pass) HARNU_VERIFY_* in the flag settings sets Harnu's parts aside [16.88ms]
(pass) HARNU_VERIFY_* in the policy settings sets Harnu's parts aside [12.47ms]
(pass) a hit visible only in the merged read still sets the parts aside [13.27ms]

 87 pass
 0 fail
Ran 87 tests across 1 file. [2.33s]
```

`tsc -p <scratch>/tsc` (the header's `tsconfig.json`, kept outside the mod folder): no output,
**exit 0**.

```json
{
  "compilerOptions": {
    "target": "es2023",
    "lib": ["es2023"],
    "types": [],
    "module": "esnext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noEmit": true,
    "skipLibCheck": true,
    "jsx": "react",
    "jsxFactory": "h",
    "jsxFragmentFactory": "Fragment"
  },
  "include": [
    "<skill>/types/claude-code.d.ts",
    "../harnu-verify-gate/hooks",
    "../harnu-verify-gate/types",
    "../harnu-verify-gate/tests"
  ]
}
```

**How the suite guards the trust claims.** Every test's `world` records each `fs.read` in
`fsReads` and also makes it throw. The engine **skips a hook that throws**, so a throwing guard
alone proves nothing: the round-2 verifier showed an unwrapped read failing 18 of 20 tests and the
same read inside `try/catch` passing all 20. The proof is two things: validate's `calls:` line
above lists **no `$.fs`**, and the trust test asserts `fsReads` is empty.

**The classifier, round 4** (spec §6.2). Rounds 2 and 3 each patched a list of separators and each
was evaded live. The classifier is now an allowlist, and the suite grew from 32 to 87 tests:

- the verifier's evasions, each asserted to be **no receipt** (the gate runs the part and denies on
  its red): `sh check.sh && sh check.sh again & true`, the same with a newline and with CR LF,
  `sh check.sh $(…)`, a backtick form, `<(…)`, `(sh check.sh)`, `{ sh check.sh; }` and
  `sh check.sh && true`;
- the honest shape `npm run typecheck && npx vitest run --reporter=dot` + newline + `echo "exit=$?"`:
  neither part is recorded green, so both re-run;
- a **fuzz table, one row per metacharacter** (19: lone `&`, `;`, `|`, `||`, `&&&`, newline, CR,
  backtick, `$(`, `<(`, `(`, `)`, `<`, `>`, `>>`, `{`, `}`, `\`, `$`). Each row has two tests:
  `sh check.sh <c> true` is never a receipt, and after a green receipt `sh check.sh x <c>rm -rf
src` is an edit (the gate re-runs);
- parts joined by `&&` with neutral commands are still a receipt, and a part joined to a narrower
  run of itself is not;
- `HARNU_VERIFY_*` in the `user`, `flag` or `policy` settings, or visible only in the merged read,
  sets Harnu's parts aside (the `project` and `local` tests are from round 3).

**Negative control.** The same 87-test file run against the **round-3** `register.ts` (kept in the
scratchpad) gives **66 pass, 21 fail**. The failures are the evasions (`& true`, newline, CR LF),
the honest shape, the narrower-joined case, 13 of the 19 "hidden write" rows, and the three
settings tests for `flag`, `policy` and the merge. Against the round-4 source, all 87 pass.

**What the round-4 runs caught on the way**: the suite's `settings.read` stub had to answer a
call with no source (the merge), and a stub that answers only per source hides the merge test.

Earlier rounds' catches still hold: `$` only to top-level functions; the list matcher for a
one-of; `$.tool.check` as a kit **query** (`ToolCheckArgs` = `tool` + `input`, TYPES:12796); a
streaming bottom hook returns `{ value }`; a stream ended by `return()` resolves with no value.

## Live runs of the round-4 prototype (R11-R13)

`claude -p --model haiku --permission-mode bypassPermissions --plugin-dir <mod>` in a fresh
throwaway git repo, `HARNU_VERIFY_GATE=enforce`, `HARNU_VERIFY_ROOT=<the repo>` and
`HARNU_VERIFY_CMD='["sh check.sh"]'` as Harnu would set them, where `check.sh` prints
`check-red-from-script` and exits 1. Each wrote a file, ran the command below, then `gh pr ready
999`, and quoted what the Bash tool returned for the last. The three evasions are the ones the
round-3 verifier ran, now on the round-4 source.

| Run | The session's Bash command                                       | Result                                                                                                                       |
| --- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| R11 | `sh check.sh && sh check.sh again & true`                        | **denied**: "`sh check.sh` failed after the last edit (run by the gate)", tail `check-red-from-script`                       |
| R12 | the two-line command `sh check.sh && sh check.sh again` ⏎ `true` | **denied**, same reason and tail                                                                                             |
| R13 | `sh check.sh $(touch SUB-RAN)`                                   | **denied**, same reason. `SUB-RAN` exists in the repo: the substitution ran, so the call was an **edit** and the gate re-ran |

In each, the verdict text reads `rtk gh pr ready 999`, as on every run on this machine (its `rtk`
hook rewrites `gh …`). In round 3, R11 and R12 were **not** denied (V-R3).

## Live runs of the round-3 prototype (R6-R10)

These ran on the **round-3** source (kept in this file's history at `a0ec024`); its classifier was an
exclusion list of separators, replaced in round 4. R6-R9 used `claude -p --model haiku --plugin-dir <mod>`,
R10 an interactive session under tmux, each in a fresh throwaway git repo in the scratchpad with
`HARNU_VERIFY_GATE=enforce`, `HARNU_VERIFY_ROOT=<the repo>` and `HARNU_VERIFY_CMD=<approved parts>`
as Harnu would set them. This machine's `rtk` hook rewrites `gh …` to `rtk gh …`, which is why
quotes read `rtk gh pr ready 999`.

**R6 — a piped check no longer records green.** Approved part `["sh check.sh"]`, where `check.sh`
prints `check-red-from-script` and exits 1. The model wrote a file, ran `sh check.sh 2>&1 | tail
-5` (exit status `tail`'s, 0), then `gh pr ready 999`. Round 2 let this through (V-R2a). Now it
quoted:

```
Permission to use Bash denied by plugin harnu-verify-gate: [verify-gate] `rtk gh pr ready 999` refused: `sh check.sh` failed after the last edit (run by the gate). Fix it, run it again, then claim. Output tail:
check-red-from-script
```

The session's piped run was no receipt, so the gate ran the part itself and found it red. The run
used `--permission-mode bypassPermissions`, so `$.tool.check` answered `allow`.

**R7 — the session's permissions decide.** Same repo, a part `["sh check.sh"]` that exits 0, **no**
allow rule for `sh check.sh` and no bypass (only `Write` and `gh pr ready` allowed). The model
quoted:

```
Permission to use Bash denied by plugin harnu-verify-gate: [verify-gate] `rtk gh pr ready 999` refused: the gate could not run `sh check.sh` (this session's permissions would ask before running it). Run it yourself with Bash; a green run after your last edit counts.
```

The gate did not run the part: `$.tool.check` for `sh check.sh` answered `ask`, so it handed the run
back. This is the case where the approved text would have executed a script the model could edit,
with no Bash prompt.

**R8 — a planted settings file.** `.claude/settings.local.json` in the worktree held
`{"env":{"HARNU_VERIFY_CMD":"[\"touch PWNED\"]"}}`, a file the model can write. The claim went
through the stand-in `harnu` MCP server of R2, and the model quoted:

```
tool.call hook additional context: [verify-gate] claim on stp-2: no operator-approved verify command applies here (HARNU_VERIFY_* is set in the local settings); this claim is unverified.
```

The server logged the call (rule D lets a claim through unchecked), no `PWNED` file exists, and
the gate ran nothing. **What this does not show** is whether Claude Code applies that settings
`env` block to the process env at all, which is assumption A8 for W0. The refusal is safe either
way: it only removes the parts.

**R9 — a 400 s check against the 300 s default, on round-3 code.** Part `["sh slow.sh"]` (`sleep
400`, then exit 1), with `Bash(sh slow.sh)` allowed so `$.tool.check` answered `allow`. The model
quoted:

```
Permission to use Bash denied by plugin harnu-verify-gate: [verify-gate] `rtk gh pr ready 999` refused: the gate could not run `sh slow.sh` (still running after 300 s). Run it yourself with Bash; a green run after your last edit counts.
```

317 s wall, and `pgrep -a -x sleep` afterwards found **no `sleep 400` alive**.

**R10 — Esc in an interactive session, on round-3 code.** `claude --plugin-dir <mod>
--permission-mode acceptEdits` under tmux, `Bash(sh slow.sh)` allowed, part `["sh slow.sh"]` (`sleep
117`, exit 1). While the gate ran, the pane read `⚠ harnu-verify-gate: verify-gate: running sh
slow.sh`, and `pgrep -a -x sleep` showed `sleep 117` (pid 920115). After `tmux send-keys Escape`
the child was **gone at the first one-second poll**, the pane read `Interrupted · What should Claude
do instead?`, and a second "run `gh pr ready 999` again" started a **new** `sleep 117` (pid
921631): the interrupted run had recorded nothing. A second Esc killed it, and after `/exit` no
gate child was left. (The round-2 verifier measured about 2 s with a `sleep 173`.)

## Live runs of the round-2 prototype (R1-R5)

These ran on the **round-2** source (kept in this file's history at `ea2a9b8`). R3 and R4 were repeated on round-3 code as R9, and R5 as R10. Each ran `claude -p --model haiku --plugin-dir <mod>` (R5: interactive, under tmux) in a fresh
throwaway git repo in the scratchpad. **Inside-Harnu runs set the two variables Harnu would set at
spawn**: `HARNU_VERIFY_GATE=enforce` and `HARNU_VERIFY_CMD=<approved parts as JSON>`. The model
was asked to write or edit a file, then make a claim, then quote what came back. This machine has
a settings `PreToolUse` hook that rewrites `gh …` to `rtk gh …` before `tool.check` sees it; the
gate's unanchored regex still matches, which is why the quotes read `rtk gh pr ready 999`.

**R1 — the working tree cannot choose the command.** The repo's committed `WORKTREE.md` said
`verify: touch PWNED-committed`. The approved command was `echo approved-check-red; exit 1`. The
model was told to **edit `WORKTREE.md` to `verify: touch PWNED-by-model`**, then run `gh pr ready
999`. It did both (`git diff` shows the edit). The model quoted:

```
Permission to use Bash denied by plugin harnu-verify-gate: [verify-gate] `rtk gh pr ready 999` refused: `echo approved-check-red; exit 1` failed after the last edit (run by the gate). Fix it, run it again, then claim. Output tail:
approved-check-red
```

No `PWNED*` file exists in the repo afterwards. Only the approved command ran; neither the committed
line nor the model's line did. 27 s wall.

**R2 — the Mission claim through an MCP server named `harnu`.** `claude -p` has no Harnu MCP
server, so the run used a stand-in: the stdio server below, registered as `harnu` with
`--mcp-config … --strict-mcp-config`. It offers `mission_update_step` and appends every call it
receives to a log. Red (`["echo mcp-check-red; exit 1"]`) and green (`["echo mcp-check-green"]`)
ran in parallel.

Red, as the model quoted it:

```
[verify-gate] claim on stp-2 refused: `echo mcp-check-red; exit 1` failed after the last edit (run by the gate). Fix it, run it again, then claim. Output tail:
mcp-check-red
```

The server's log stayed **empty**.

Green: the verb answered `{"ok":true,"stepId":"stp-2"}`, the server logged the call with
`"set":{"proof":"claimed"}`, and the model reported "a separate harness note arrived after that
result": `[verify-gate] echo mcp-check-green passed (run by the gate) after the last edit.`

**R3 — a 290 s check.** `["sleep 290; echo slow-check-red; exit 1"]`, run on the formatted bytes
pasted below. The model quoted:

```
Permission to use Bash denied by plugin harnu-verify-gate: [verify-gate] `rtk gh pr ready 999` refused: `sleep 290; echo slow-check-red; exit 1` failed after the last edit (run by the gate). Fix it, run it again, then claim. Output tail:
slow-check-red
```

The whole run took **307 s**. A first run before the formatting pass gave the same result in 308 s;
it is not quoted, because its marker text trips this repo's client-identifier gate.

**R4 — a 400 s check against the 300 s default.** `["sleep 400; echo never-printed; exit 1"]`.
The model quoted:

```
Permission to use Bash denied by plugin harnu-verify-gate: [verify-gate] `rtk gh pr ready 999` refused: the gate could not run `sleep 400; echo never-printed; exit 1` (still running after 300 s). Run it yourself with Bash; a green run after your last edit counts.
```

317 s wall. `pgrep -af "sleep 400"` afterwards: **no `sleep 400` alive**. The timer's `return()`
killed the child.

**R5 — Esc in an interactive session.** `claude --plugin-dir <mod> --permission-mode acceptEdits`
under tmux, with `HARNU_VERIFY_CMD='["sleep 117; echo esc-red; exit 1"]'`. The prompt asked for a
`Write`, then `gh pr ready 999`. While the gate ran, the pane's status line read:

```
  ⚠ harnu-verify-gate: verify-gate: running sleep 117; echo esc-red; exit 1
```

`pgrep -a -x sleep` showed `sleep 117` (pid 789980). After `tmux send-keys Escape`, the child was
**gone within 1 s** (`kill -0` failed at the first poll). The pane read
`● Bash(gh pr ready 999) ⎿ Interrupted · What should Claude do instead?`, and the status line was
cleared.

A second prompt, "run `gh pr ready 999` again", **started `sleep 117` again** (a new pid). The
interrupted run had recorded nothing. A second Esc killed it again, and after `/exit` no gate child
was left.

## Live runs of the round-1 prototype (P1-P6)

Round 1 read the command from the working tree with `$.fs.read` (since removed, spec §7.1) and ran
it with `$.process.run` (since replaced). These runs are kept for the mechanisms round 2 did not
change. The full round-1 record is in this file's history at `d0864d5`.

| Run   | What it showed                                                                                                                                   | Still relevant to round 2                  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| P1    | A red check denies a real `gh pr ready` at `tool.check`. An `Edit` reached the ledger through `classic.PostToolUse`                              | Yes: the same hooks                        |
| P2    | A `context` note on a `tool.call` result reaches the model (that run's hook was a Bash `tool.call`, since removed)                               | The `context` path, now shown on MCP by R2 |
| P3    | A 15 s check outlives the 10 s budget                                                                                                            | Superseded by R3 and R4                    |
| P4    | `Agent(isolation: "worktree")` keeps its worktree with the gate loaded, against a no-mod control. Both runs met an `rtk`-caused refusal of `git` | Yes: round 2 adds no `tool.call` on Bash   |
| P5/P6 | The MCP claim deny and receipt against the stand-in server                                                                                       | Re-run on round 2 as R2                    |

## Independent runs

These were made by other sessions and are read from their scratch, not re-run here.

| Id    | By                    | What it showed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V-45  | T452 round-1 verifier | A 45 s check inside `tool.check` delivered its deny, 67 s wall, under `bypassPermissions`                                                                                                                                                                                                                                                                                                                                                                                                                           |
| V-A2  | T452 round-1 verifier | The session's own `sh check.sh`, exiting 1, arrived as `PostToolUseFailure`: the claim was denied with the tail `Exit code 1 / first-run-red-by-session`, and nothing re-ran                                                                                                                                                                                                                                                                                                                                        |
| V-A3  | T452 round-1 verifier | After a green run, a background `Agent` wrote `sub.txt`; `gh pr ready` re-ran the check (tail `second-run-red-gate-reran`). A subagent's edit reaches the parent's ledger                                                                                                                                                                                                                                                                                                                                           |
| V-R2a | T452 round-2 verifier | Live, with the approved part `sh check.sh` (always exit 1) and `enforce`: `sh check.sh 2>&1 \| tail -5`, `sh check.sh \|\| true` and `sh check.sh; rm -r x` were each **not denied**, and the `rm` was not counted as an edit; the bare `sh check.sh` was denied. This is the round-2 bug that R6 and the kit now cover                                                                                                                                                                                             |
| V-R2b | T452 round-2 verifier | Esc during a `sleep 173` check in an interactive session: both the child and its `sh` parent were gone within about 2 s                                                                                                                                                                                                                                                                                                                                                                                             |
| V-R2c | T452 round-2 verifier | A mutation of the round-2 prototype: an unwrapped `$.fs.read` in `policy()` failed 18 of 20 tests, and the same read in `try/catch` passed 20/0. So a throwing guard in the kit proves nothing by itself (spec §4, `$.fs.read`)                                                                                                                                                                                                                                                                                     |
| V-R3  | T452 round-3 verifier | Live, with the approved part `sh check.sh` (always exit 1): `sh check.sh && sh check.sh again & true` and `sh check.sh && sh check.sh again` + newline + `true` were **not denied**, and `gh pr ready` ran. The same classifier calls `npm run typecheck && npx vitest run --reporter=dot` + newline + `echo "exit=$?"` a receipt, and `sh check.sh x & rm -rf src` and `sh check.sh $(rm -rf src)` neutral. R11-R13 and the fuzz table cover them. Also: a `$.tool.check` query runs no classic hook (TYPES:12883) |
| V450  | T450 verifier         | On 2.1.296 headless, with `rtk` off, a pass-through Bash `tool.call` hook (`b4-mod4`: "[tool.call saw agent=aa141c36015a3312b]") left `Agent(isolation: "worktree")` intact: pwd and branch inside the agent's worktree, `made.txt` written there                                                                                                                                                                                                                                                                   |

## `.claude-plugin/plugin.json`

```json
{
  "name": "harnu-verify-gate",
  "version": "0.4.0",
  "author": { "name": "Harnu" },
  "description": "Done means the check ran: gates a session's own completion claims on a fresh verification run.",
  "types": "./types/index.d.ts",
  "userConfig": {
    "mode": {
      "type": "string",
      "title": "Mode",
      "description": "Outside Harnu. annotate: warn on an unchecked claim, never run anything; enforce: run the check below and refuse a red claim; off: do nothing.",
      "default": "annotate",
      "options": ["annotate", "enforce", "off"]
    },
    "check": {
      "type": "string",
      "title": "Check command",
      "description": "Outside Harnu: the POSIX command line enforce runs. Inside Harnu it is ignored; Harnu passes the operator-approved command.",
      "default": ""
    },
    "timeoutSeconds": {
      "type": "number",
      "title": "Check timeout (seconds)",
      "description": "How long the gate lets one check part run, 600 at most.",
      "default": 300
    }
  }
}
```

## `hooks/hooks.json`

```json
{ "modules": ["./register.ts"] }
```

## `types/index.d.ts`

```ts
/** One run of one check part: the session's own Bash run, or the gate's. */
export type CheckRun = {
  /** The part's text, exactly as the policy names it. */
  part: string
  /** Ledger position of the run; it counts when it is greater than `lastEditSeq`. */
  seq: number
  ok: boolean
  by: 'session' | 'gate'
  /** Epoch ms. */
  at: number
  /** The last lines of the output, for a deny reason and a receipt. */
  tail: string
}

/** The session's own tool-call log, reduced to what "ran since the last edit" needs. */
export type Ledger = {
  /** Increments on every observed tool call. */
  seq: number
  /** `seq` of the last call that may have changed the tree; 0 when none did. */
  lastEditSeq: number
  /** What that call was (`Edit src/a.ts`, `Bash: npm i x`), for the reason text. */
  lastEdit: string
  /** The latest run of each check part, keyed by the part's text. */
  runs: Record<string, CheckRun>
}

declare module 'claude-code' {
  interface PluginState {
    'harnu-verify-gate': { ledger: Ledger }
  }
}
```

## `hooks/register.ts`

```ts
import type { EngineInterface, Register, ToolCallResult } from 'claude-code'
import { atom, read, update } from 'claude-code'
import type { CheckRun, Ledger } from '../types'

/** The session's own tool-call log (§6). `$.state` is per session and survives a hot reload. */
const ledger = atom(
  { plugin: 'harnu-verify-gate', key: 'ledger' } as const,
  {
    seq: 0,
    lastEditSeq: 0,
    lastEdit: '',
    runs: {}
  } as Ledger
)

type Options = { mode: string; check: string; timeoutMs: number }
/** What judges a claim: the mode and the check's parts, from a source the model cannot write (§7). */
type Policy = {
  mode: 'off' | 'annotate' | 'enforce'
  parts: string[]
  inHarnu: boolean
  /** Why Harnu's parts were set aside, when they were (§7.6). */
  refused?: string
}

type Verdict =
  | { kind: 'not-author' }
  | { kind: 'no-check'; inHarnu: boolean; refused?: string }
  | { kind: 'green'; run: CheckRun }
  | { kind: 'red'; run: CheckRun }
  | { kind: 'stale'; parts: string[]; lastEdit: string }
  | { kind: 'unrun'; part: string; why: string }
  | { kind: 'aborted' }

/** How one finished Bash call reads against the parts (§6.2). */
type BashClass = { kind: 'run'; parts: string[] } | { kind: 'edit' } | { kind: 'neutral' }

const TAIL_LINES = 40
const TAIL_CHARS = 3_000
const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit']
const PR_CLAIM = /\bgh\s+pr\s+(create|ready)\b/
const DRAFT = /\s(--draft|-d)(\s|$)/
const DONE_WORDS = /\b(done|completed?|finished|all tests pass(ed)?|ready for review)\b/i
const RECEIPT_MARK = '[verify-gate]'
const NEUTRAL =
  /^(git\s+(status|log|diff|show|add|commit|push|fetch|rev-parse|rev-list|branch)\b|gh\s|ls\b|cat\b|head\b|tail\b|wc\b|rg\b|grep\b|pwd\b|echo\b)/
const DIR_CHANGE = /^(cd|pushd|popd)\b/
/** Redirections that write no file: to another descriptor, or to /dev/null. */
const HARMLESS_REDIRECT = /\s+\d*>&\d+|\s+\d*>{1,2}\s*\/dev\/null/g
/** Every way one command is followed by another, or goes to the background (`&&` included). */
const JOIN = /[&;|\n\r]/
/** Anything that can embed a command, write a file, or hide a separator from a split. */
const EMBED = /[`$(){}<>\\]/
const MODES = ['off', 'annotate', 'enforce']
/** Each settings source on its own, then the merge: a merge may shadow an `env` block (§7.6 b). */
const SETTINGS_SOURCES = ['user', 'project', 'local', 'flag', 'policy'] as const

const tailOf = (text: string): string =>
  text.split('\n').slice(-TAIL_LINES).join('\n').slice(-TAIL_CHARS)

const field = (value: unknown, key: string): string => {
  const v =
    typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)[key]
      : undefined
  return typeof v === 'string' ? v : ''
}

const parseParts = (json: string | undefined): string[] => {
  try {
    const v: unknown = JSON.parse(json ?? '[]')
    return Array.isArray(v)
      ? v.filter((p): p is string => typeof p === 'string' && p.trim() !== '')
      : []
  } catch {
    return []
  }
}

const asMode = (value: string): Policy['mode'] =>
  MODES.includes(value) ? (value as Policy['mode']) : 'annotate'

/**
 * Classifies one finished Bash call (§6.2) with a strict allowlist, not a list of bad separators.
 *
 * A call is a **receipt** only when, once harmless trailing redirections are removed, it is
 * nothing but approved parts and neutral read-only commands joined by `&&`, with no other shell
 * metacharacter anywhere: the call's exit status is then the last command's, and `&&` makes a
 * failure stop the chain. Anything else leaves the outcome unknown. Separately, a call is an
 * **edit** when it may write: any metacharacter that can embed a command or redirect, or any
 * command, however it is joined, that is not a part, a narrower run of a part, a directory change
 * or neutral. The two checks are independent, and the edit check also fires on unknown runs.
 */
const classifyBash = (command: string, parts: readonly string[]): BashClass => {
  const cleaned = command.replace(HARMLESS_REDIRECT, '')
  const isPart = (s: string) => parts.includes(s)
  const plain = (s: string) => !EMBED.test(s)
  const isNarrower = (s: string) => plain(s) && parts.some((p) => s.startsWith(`${p} `))
  const known = (s: string) =>
    plain(s) && (isPart(s) || isNarrower(s) || DIR_CHANGE.test(s) || NEUTRAL.test(s))
  const loose = cleaned
    .split(/[&;|\n\r]+/)
    .map((s) => s.trim())
    .filter((s) => s !== '')
  if (EMBED.test(cleaned) || !loose.every(known)) return { kind: 'edit' }
  const chain = cleaned.split('&&').map((s) => s.trim())
  const strict =
    !JOIN.test(cleaned.replaceAll('&&', '')) && chain.every((s) => isPart(s) || NEUTRAL.test(s))
  const ran = chain.filter(isPart)
  return strict && ran.length > 0 ? { kind: 'run', parts: ran } : { kind: 'neutral' }
}

/**
 * Inside Harnu (`HARNU_VERIFY_GATE` set at spawn) the mode and the operator-approved parts come
 * from the spawn's env, bound to the session root they were approved for, and refused when a
 * settings file the session can write could have planted them. Outside Harnu, the person's
 * userConfig. Nothing in the working tree is read (§7).
 */
async function policy($: EngineInterface, opts: Options): Promise<Policy> {
  const mode = await $.env.get('HARNU_VERIFY_GATE')
  if (mode === undefined) {
    const check = opts.check.trim()
    return { mode: asMode(opts.mode), parts: check === '' ? [] : [check], inHarnu: false }
  }
  const base = { mode: asMode(mode), inHarnu: true }
  const hit = (env: unknown) =>
    typeof env === 'object' &&
    env !== null &&
    Object.keys(env).some((k) => k.startsWith('HARNU_VERIFY_'))
  for (const source of SETTINGS_SOURCES) {
    if (hit((await $.settings.read({ source })).env))
      return { ...base, parts: [], refused: `HARNU_VERIFY_* is set in the ${source} settings` }
  }
  // The merge as the engine runs under it, in case a source's `env` block shadows another's.
  if (hit((await $.settings.read()).env))
    return { ...base, parts: [], refused: 'HARNU_VERIFY_* is set in the merged settings' }
  const root = await $.env.get('HARNU_VERIFY_ROOT')
  if (root !== (await $.session.root()))
    return { ...base, parts: [], refused: 'the approved command belongs to another folder' }
  return { ...base, parts: parseParts(await $.env.get('HARNU_VERIFY_CMD')) }
}

async function bump($: EngineInterface, edit?: string): Promise<void> {
  await update($, ledger, (l) =>
    edit === undefined
      ? { ...l, seq: l.seq + 1 }
      : { ...l, seq: l.seq + 1, lastEditSeq: l.seq + 1, lastEdit: edit }
  )
}

async function record(
  $: EngineInterface,
  parts: string[],
  run: Omit<CheckRun, 'seq' | 'at' | 'part'>
): Promise<CheckRun> {
  const at = await $.clock.now()
  const next = await update($, ledger, (l) => {
    const runs = { ...l.runs }
    for (const part of parts) runs[part] = { ...run, part, seq: l.seq + 1, at }
    return { ...l, seq: l.seq + 1, runs }
  })
  return next.runs[parts[0]!]!
}

/** One finished tool call into the ledger: an edit, a run of one or more parts, or neither (§6.2). */
async function observe(
  $: EngineInterface,
  opts: Options,
  tool: string,
  input: unknown,
  response: unknown,
  ok: boolean,
  output: string
): Promise<void> {
  if (EDIT_TOOLS.includes(tool)) {
    if (ok) await bump($, `${tool} ${field(input, 'file_path') || field(input, 'notebook_path')}`)
    return
  }
  if (tool !== 'Bash') return
  const command = field(input, 'command')
  const c = classifyBash(command, (await policy($, opts)).parts)
  if (c.kind === 'edit') return bump($, `Bash: ${command.trim().slice(0, 80)}`)
  // A background run reports before the check finishes: never a receipt.
  if (c.kind === 'neutral' || field(response, 'backgroundTaskId') !== '') return bump($)
  await record($, c.parts, { ok, by: 'session', tail: tailOf(output) })
}

/**
 * Runs one part through `$.process.spawn`, whose loop is the child's life: an abort of the
 * claim's dispatch (Esc) or the timeout's `return()` kills the child (§8.3).
 */
async function runPart(
  $: EngineInterface,
  part: string,
  timeoutMs: number,
  signal: AbortSignal
): Promise<{ code: number | null; out: string; timedOut: boolean }> {
  const child = $.process.spawn({
    argv: ['sh', '-c', part],
    cwd: await $.session.root(),
    env: { CI: '1' }
  })
  let timedOut = false
  const timer = $.clock.after(timeoutMs, () => {
    timedOut = true
    void child.return(undefined as never)
  })
  let out = ''
  try {
    let step = await child.next()
    while (step.done !== true && !signal.aborted) {
      out = (out + step.value.text).slice(-64_000)
      step = await child.next()
    }
    if (timedOut || step.done !== true || step.value === undefined)
      return { code: null, out, timedOut }
    return { code: step.value.code, out, timedOut }
  } finally {
    timer.cancel()
  }
}

/**
 * The session's own permission mode decides whether the gate may run a part (§8.1): the approved
 * text runs the branch's scripts, which the model can edit.
 */
async function permitted($: EngineInterface, part: string): Promise<string | undefined> {
  const v = await $.tool.check({ tool: 'Bash', input: { command: part } })
  if (v.decision === 'allow') return undefined
  return v.decision === 'ask'
    ? "this session's permissions would ask before running it"
    : "this session's permissions refuse it"
}

/** Does a green run of every part cover the last edit? Runs the missing parts when it may (§5.2, §8). */
async function judge(
  $: EngineInterface,
  opts: Options,
  mayRun: boolean,
  signal: AbortSignal
): Promise<Verdict> {
  const l = await read($, ledger)
  if (l.lastEditSeq === 0) return { kind: 'not-author' }
  const p = await policy($, opts)
  if (p.parts.length === 0) return { kind: 'no-check', inHarnu: p.inHarnu, refused: p.refused }
  const fresh = (part: string) => {
    const r = l.runs[part]
    return r !== undefined && r.seq > l.lastEditSeq ? r : undefined
  }
  const red = p.parts.map(fresh).find((r) => r !== undefined && !r.ok)
  if (red !== undefined) return { kind: 'red', run: red }
  const missing = p.parts.filter((part) => fresh(part) === undefined)
  if (missing.length === 0) return { kind: 'green', run: fresh(p.parts.at(-1)!)! }
  if (p.mode !== 'enforce' || !mayRun)
    return { kind: 'stale', parts: missing, lastEdit: l.lastEdit }
  let last: CheckRun | undefined
  for (const part of missing) {
    const denied = await permitted($, part)
    if (denied !== undefined) return { kind: 'unrun', part, why: denied }
    $.ui.status(`verify-gate: running ${part}`)
    let ran
    try {
      ran = await runPart($, part, opts.timeoutMs, signal)
    } catch (err) {
      return { kind: 'unrun', part, why: err instanceof Error ? err.message : String(err) }
    } finally {
      $.ui.status(undefined)
    }
    // An interrupted claim records nothing: the run did not finish, and nobody waits for it.
    if (signal.aborted) return { kind: 'aborted' }
    if (ran.timedOut)
      return { kind: 'unrun', part, why: `still running after ${opts.timeoutMs / 1_000} s` }
    last = await record($, [part], { ok: ran.code === 0, by: 'gate', tail: tailOf(ran.out.trim()) })
    if (!last.ok) return { kind: 'red', run: last }
  }
  return { kind: 'green', run: last! }
}

const ranBy = (run: CheckRun) => (run.by === 'gate' ? 'run by the gate' : 'run by this session')

/** The one-line answer for a verdict: a refusal, or a note that rides along (§5.2). */
function wording(v: Verdict, claim: string): { deny: string } | { note: string } | undefined {
  switch (v.kind) {
    case 'not-author':
    case 'aborted':
      return undefined
    case 'no-check':
      return {
        note: v.inHarnu
          ? `${RECEIPT_MARK} ${claim}: no operator-approved verify command applies here${v.refused === undefined ? '' : ` (${v.refused})`}; this claim is unverified.`
          : `${RECEIPT_MARK} ${claim}: no check is configured; this claim is unverified.`
      }
    case 'green':
      return {
        note: `${RECEIPT_MARK} \`${v.run.part}\` passed (${ranBy(v.run)}) after the last edit.`
      }
    case 'stale':
      return {
        note: `${RECEIPT_MARK} ${claim}: no green run since the last edit (${v.lastEdit}). Run ${v.parts.map((p) => `\`${p}\``).join(', ')}.`
      }
    case 'red':
      return {
        deny: `${RECEIPT_MARK} ${claim} refused: \`${v.run.part}\` failed after the last edit (${ranBy(v.run)}). Fix it, run it again, then claim. Output tail:\n${v.run.tail}`
      }
    case 'unrun':
      return {
        deny: `${RECEIPT_MARK} ${claim} refused: the gate could not run \`${v.part}\` (${v.why}). Run it yourself with Bash; a green run after your last edit counts.`
      }
  }
}

/** A Harnu verb claim at `tool.call`: refused when red or unrunnable, passed with a note otherwise. */
async function gateCall(
  $: EngineInterface,
  opts: Options,
  claim: string,
  signal: AbortSignal,
  pass: () => Promise<ToolCallResult>
): Promise<ToolCallResult> {
  const w = wording(await judge($, opts, true, signal), claim)
  if (w !== undefined && 'deny' in w) return { deny: w.deny }
  const r = await pass()
  return w === undefined || r.deny !== undefined
    ? r
    : { ...r, context: [...(r.context ?? []), w.note] }
}

/** A Bash claim at `tool.check` (#92533: never `tool.call` on Bash). Only a real call may run a check. */
async function gateBash(
  $: EngineInterface,
  opts: Options,
  command: string,
  isRealCall: boolean,
  signal: AbortSignal
): Promise<string | undefined> {
  const w = wording(await judge($, opts, isRealCall, signal), `\`${command.trim()}\``)
  return w !== undefined && 'deny' in w ? w.deny : undefined
}

/**
 * The receipt line a completion report must carry now; undefined when it needs none or already
 * carries this exact line. A line copied from an earlier report does not count (§5.1 rows 7, 12).
 */
async function receiptLine(
  $: EngineInterface,
  opts: Options,
  text: string
): Promise<string | undefined> {
  if (!DONE_WORDS.test(text)) return undefined
  const w = wording(await judge($, opts, false, new AbortController().signal), 'this report')
  if (w === undefined) return undefined
  const line = 'deny' in w ? w.deny.split('\n')[0]! : w.note
  return text.includes(line) ? undefined : line
}

async function staleDone($: EngineInterface, opts: Options): Promise<string | undefined> {
  const l = await read($, ledger)
  if (l.lastEditSeq === 0) return undefined
  const p = await policy($, opts)
  if (p.mode === 'off') return undefined
  const covered =
    p.parts.length > 0 &&
    p.parts.every((part) => {
      const r = l.runs[part]
      return r !== undefined && r.seq > l.lastEditSeq && r.ok
    })
  return covered
    ? undefined
    : `⚠ verify-gate: this reply claims completion, but no green check ran since the last edit (${l.lastEdit}).`
}

async function isOff($: EngineInterface, opts: Options): Promise<boolean> {
  return (await policy($, opts)).mode === 'off'
}

export const register: Register = (on, options) => {
  const opts: Options = {
    mode: String(options.mode ?? 'annotate'),
    check: String(options.check ?? ''),
    timeoutMs: Math.min(600, Math.max(1, Number(options.timeoutSeconds ?? 300))) * 1_000
  }

  // The ledger: every finished call of the four tools, main loop and subagents alike.
  on('classic.PostToolUse', async ($, e, next) => {
    const r = await next(e)
    const out = e.tool_response
    const text = `${field(out, 'stdout')}\n${field(out, 'stderr')}`.trim()
    await observe($, opts, e.tool_name, e.tool_input, out, true, text)
    return r
  }).catch(($, e, next) => next(e))

  on('classic.PostToolUseFailure', async ($, e, next) => {
    const r = await next(e)
    await observe($, opts, e.tool_name, e.tool_input, undefined, false, e.error)
    return r
  }).catch(($, e, next) => next(e))

  // A resumed or cleared session cannot know what it edited before: the first claim checks (§6.3).
  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    if (e.source === 'resume' || e.source === 'clear') {
      const edit = `(edits before ${e.source} are unknown)`
      await update($, ledger, (l) =>
        l.lastEditSeq > 0 ? l : { ...l, seq: l.seq + 1, lastEditSeq: l.seq + 1, lastEdit: edit }
      )
    }
    return r
  }).catch(($, e, next) => next(e))

  // The claims.
  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    const r = await next(e)
    const command = field(e.input, 'command')
    if (r.decision === 'deny' || !PR_CLAIM.test(command) || DRAFT.test(command)) return r
    if (await isOff($, opts)) return r
    const deny = await gateBash($, opts, command, e.tool_use_id !== undefined, next.signal)
    return deny === undefined ? r : { decision: 'deny' as const, reason: deny }
  }).catch(($, e, next) => next(e))

  on(
    'tool.call',
    { tool: ['mcp__harnu__mission_update_step', 'mcp__capy__mission_update_step'] },
    async ($, e, next) => {
      const set = (e.set ?? {}) as Record<string, unknown>
      if (set.proof !== 'claimed' || (await isOff($, opts))) return next(e)
      return gateCall($, opts, `claim on ${String(e.stepId)}`, next.signal, () => next(e))
    }
  ).catch(($, e, next) => next(e))

  on(
    'tool.call',
    { tool: ['mcp__harnu__move_card', 'mcp__capy__move_card'] },
    async ($, e, next) => {
      if (e.to !== 'review' || (await isOff($, opts))) return next(e)
      return gateCall($, opts, `move of ${String(e.slug)} to review`, next.signal, () => next(e))
    }
  ).catch(($, e, next) => next(e))

  // A report to another session: SendMessage and $.session.send carry the receipt line (row 7).
  on('session.send', async ($, e, next) => {
    if (await isOff($, opts)) return next(e)
    const line = await receiptLine($, opts, e.text)
    return next(line === undefined ? e : { ...e, text: `${e.text}\n\n${line}` })
  }).catch(($, e, next) => next(e))

  // Its MCP twin: an input rewrite is refused in auto mode (T389/P2W5), so ask for a re-send (row 12).
  on(
    'tool.call',
    { tool: ['mcp__harnu__message_session', 'mcp__capy__message_session'] },
    async ($, e, next) => {
      if (await isOff($, opts)) return next(e)
      const line = await receiptLine($, opts, field(e, 'message'))
      return line === undefined
        ? next(e)
        : { deny: `${RECEIPT_MARK} send it again with this line appended, as written:\n${line}` }
    }
  ).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.reason !== 'answer' || e.agentId !== undefined || !DONE_WORDS.test(r.text)) return r
    const warning = await staleDone($, opts)
    return warning === undefined ? r : { ...r, text: warning }
  })
}
```

## `tests/gate.test.ts`

```ts
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const PARTS = ['npm run typecheck', 'npx vitest run']
const CLAIM = {
  tool: 'mcp__harnu__mission_update_step',
  folder: '/repo/wt',
  missionId: 'mnt-0000abcd',
  stepId: 'stp-2',
  set: { proof: 'claimed' }
} as const

type Outcome = { code: number; output?: string } | 'hang'

/** What Harnu sets at spawn for an approved repo, bound to the session root. */
const HARNU = {
  HARNU_VERIFY_GATE: 'enforce',
  HARNU_VERIFY_CMD: JSON.stringify(PARTS),
  HARNU_VERIFY_ROOT: '/repo/wt'
}

type WorldOptions = {
  /** The session's permission verdict for a part the gate wants to run. */
  partVerdict?: 'allow' | 'ask' | 'deny'
  /** Settings files by source, as `$.settings.read({ source })` answers them. */
  settings?: Partial<
    Record<'user' | 'project' | 'local' | 'flag' | 'policy', Record<string, unknown>>
  >
  /** What the merged read (no source) answers, when it differs from the union of the sources. */
  merged?: Record<string, unknown>
}

/**
 * The engine beneath the gate. `env` stands for what Harnu sets at spawn; `outcomes` answer each
 * spawned part in order. Every `fs.read` is recorded, and the tests that matter assert none.
 */
const world = (
  on: On,
  outcomes: Outcome[],
  env: Record<string, string> = HARNU,
  o: WorldOptions = {}
) => {
  const clock = mock.clock(on, { now: 1_000 })
  mock.env(on, env)
  const runs: string[] = []
  const reached: string[] = []
  const sent: string[] = []
  const fsReads: unknown[] = []
  const asked: string[] = []
  on('fs.read', (_$, e) => {
    fsReads.push(e)
    throw new Error('the gate read a file')
  })
  on('session.root', () => ({ value: '/repo/wt' }))
  on('settings.read', (_$, e) => {
    const src = e?.source as 'user' | undefined
    if (src !== undefined) return { value: (o.settings?.[src] ?? {}) as never }
    return { value: (o.merged ?? Object.assign({}, ...Object.values(o.settings ?? {}))) as never }
  })
  on('ui.status', () => ({ value: undefined }))
  on('process.spawn', async function* (_$, e) {
    runs.push(String(e.argv[2]))
    const out = outcomes[runs.length - 1] ?? { code: 0 }
    if (out === 'hang') {
      for (;;) {
        await clock.sleep(1_000)
        yield { stream: 'stdout' as const, text: '.' }
      }
    }
    if (out.output !== undefined) yield { stream: 'stdout' as const, text: out.output }
    return { value: { code: out.code, signal: null } }
  })
  on('tool.call', (_$, e) => {
    reached.push(String(e.tool))
    return { result: { ok: true } } as never
  })
  on('tool.check', (_$, e) => {
    const command = String((e.input as { command?: unknown }).command ?? '')
    if (PARTS.includes(command) || command === 'make test') {
      asked.push(command)
      return { decision: o.partVerdict ?? 'allow' }
    }
    return { decision: 'allow' as const }
  })
  on('session.send', (_$, e) => {
    sent.push(e.text)
    return { isDelivered: true as const }
  })
  on('classic.PostToolUse', () => ({}))
  on('classic.PostToolUseFailure', () => ({}))
  on('classic.SessionStart', () => ({}))
  return { clock, runs, reached, sent, fsReads, asked }
}

let n = 0
/** A finished tool call as the engine reports it after it ran. */
const ran = ($: Engine, tool_name: string, tool_input: Record<string, unknown>, failed?: string) =>
  failed === undefined
    ? $.classic.PostToolUse({
        tool_name,
        tool_input,
        tool_response: { stdout: '', stderr: '' },
        tool_use_id: `t${++n}`
      })
    : $.classic.PostToolUseFailure({ tool_name, tool_input, error: failed, tool_use_id: `t${++n}` })
const edit = ($: Engine, file_path = 'src/a.ts') =>
  ran($, 'Edit', { file_path, old_string: 'a', new_string: 'b' })
const bash = ($: Engine, command: string, failed?: string) => ran($, 'Bash', { command }, failed)
/** `$.tool.check` in the kit is a query: no `tool_use_id`, so the gate never runs a check there. */
const bashCheck = ($: Engine, command: string) => $.tool.check({ tool: 'Bash', input: { command } })

test('a claim from a session that edited nothing passes untouched', async ($, on) => {
  const w = world(on, [])
  const r = await $.tool.call(CLAIM)
  expect(r.deny).toBeUndefined()
  expect(w.runs).toEqual([])
  expect(w.reached).toEqual(['mcp__harnu__mission_update_step'])
})

test('inside Harnu, a claim after an edit runs each approved part in order; green passes with a receipt', async ($, on) => {
  const w = world(on, [{ code: 0 }, { code: 0 }])
  await edit($)
  const r = await $.tool.call(CLAIM)
  expect(r.deny).toBeUndefined()
  expect(w.runs).toEqual(PARTS)
  expect(r.context?.at(-1)).toMatch(/`npx vitest run` passed \(run by the gate\)/)
})

test('a red part refuses the claim, says the gate ran it, stops there, and never reaches the verb', async ($, on) => {
  const w = world(on, [{ code: 2, output: 'src/a.ts(3,1): error TS2322' }])
  await edit($)
  const r = await $.tool.call(CLAIM)
  expect(r.deny).toMatch(
    /claim on stp-2 refused: `npm run typecheck` failed after the last edit \(run by the gate\)/
  )
  expect(r.deny).toMatch(/TS2322/)
  expect(w.runs).toEqual(['npm run typecheck'])
  expect(w.reached).toEqual([])
})

test('the working tree cannot choose the command: nothing approved means nothing runs', async ($, on) => {
  const w = world(on, [], { HARNU_VERIFY_GATE: 'enforce', HARNU_VERIFY_ROOT: '/repo/wt' })
  await edit($)
  await edit($, 'WORKTREE.md')
  const r = await $.tool.call(CLAIM)
  expect(r.deny).toBeUndefined()
  expect(w.runs).toEqual([])
  expect(r.context?.at(-1)).toMatch(
    /no operator-approved verify command applies here; this claim is unverified/
  )
  expect(w.fsReads).toEqual([])
})

test("the session's own runs count part by part, as separate Bash calls: nothing reruns", async ($, on) => {
  const w = world(on, [])
  await edit($)
  await bash($, 'npm run typecheck')
  await bash($, 'npx vitest run > /dev/null 2>&1')
  const r = await $.tool.call(CLAIM)
  expect(r.deny).toBeUndefined()
  expect(w.runs).toEqual([])
  expect(r.context?.at(-1)).toMatch(/run by this session/)
})

test('only the part the session did not run is run by the gate', async ($, on) => {
  const w = world(on, [{ code: 0 }])
  await edit($)
  await bash($, 'npm run typecheck')
  await $.tool.call(CLAIM)
  expect(w.runs).toEqual(['npx vitest run'])
})

test('a focused run is no receipt and no edit; an unknown command is an edit', async ($, on) => {
  const w = world(on, [{ code: 0 }, { code: 0 }])
  await edit($)
  await bash($, 'npm run typecheck && npx vitest run')
  await bash($, 'npx vitest run tests/a.test.ts')
  await $.tool.call(CLAIM)
  expect(w.runs).toEqual([])
  await bash($, "sed -i 's/a/b/' src/a.ts")
  await $.tool.call(CLAIM)
  expect(w.runs).toEqual(PARTS)
})

test("the session's own red run refuses the claim without a rerun, and says who ran it", async ($, on) => {
  const w = world(on, [])
  await edit($)
  await bash($, 'npm run typecheck', 'Exit code 2\nerror TS2322')
  const r = await $.tool.call(CLAIM)
  expect(w.runs).toEqual([])
  expect(r.deny).toMatch(/\(run by this session\)[\s\S]*error TS2322/)
})

test('an edit after a green check makes it stale; neutral git commands do not', async ($, on) => {
  const w = world(on, [{ code: 0 }, { code: 0 }])
  await edit($)
  await bash($, 'npm run typecheck && npx vitest run')
  await bash($, 'git add -A && git commit -m wip')
  await $.tool.call(CLAIM)
  expect(w.runs).toEqual([])
  await edit($, 'src/b.ts')
  await $.tool.call(CLAIM)
  expect(w.runs).toEqual(PARTS)
})

test('gh pr create: a query runs nothing; a draft is never gated; a red receipt is denied at tool.check', async ($, on) => {
  const w = world(on, [])
  await edit($)
  expect(await bashCheck($, 'gh pr create --base main --fill')).toMatchObject({ decision: 'allow' })
  expect(await bashCheck($, 'gh pr create --draft --fill')).toMatchObject({ decision: 'allow' })
  await bash($, 'npm run typecheck', 'Exit code 1\nerror TS2345')
  const r = await bashCheck($, 'gh pr ready 12')
  expect(r.decision).toBe('deny')
  expect(r.reason).toMatch(/`gh pr ready 12` refused[\s\S]*TS2345/)
  expect(w.runs).toEqual([])
})

test('move_card to review is gated, to backlog is not; the legacy capy name is gated too', async ($, on) => {
  world(on, [{ code: 1 }, { code: 1 }])
  await edit($)
  const back = await $.tool.call({
    tool: 'mcp__harnu__move_card',
    folder: '/repo/wt',
    slug: 'T1',
    to: 'backlog'
  })
  expect(back.deny).toBeUndefined()
  const review = await $.tool.call({
    tool: 'mcp__harnu__move_card',
    folder: '/repo/wt',
    slug: 'T1',
    to: 'review'
  })
  expect(review.deny).toMatch(/move of T1 to review refused/)
  const legacy = await $.tool.call({ ...CLAIM, tool: 'mcp__capy__mission_update_step' })
  expect(legacy.deny).toMatch(/claim on stp-2 refused/)
})

test(
  'a part that outlives the timeout is stopped, recorded as nothing, and handed back to the session',
  { options: { timeoutSeconds: 5 } },
  async ($, on) => {
    const w = world(on, ['hang'])
    await edit($)
    const pending = $.tool.call(CLAIM)
    await w.clock.advance(6_000)
    const r = await pending
    expect(r.deny).toMatch(
      /could not run `npm run typecheck` \(still running after 5 s\)\. Run it yourself with Bash/
    )
  }
)

test('annotate mode lets a stale claim through with a warning and runs nothing', async ($, on) => {
  const w = world(on, [], { ...HARNU, HARNU_VERIFY_GATE: 'annotate' })
  await edit($)
  const r = await $.tool.call(CLAIM)
  expect(r.deny).toBeUndefined()
  expect(w.runs).toEqual([])
  expect(r.context?.at(-1)).toMatch(
    /no green run since the last edit \(Edit src\/a.ts\)\. Run `npm run typecheck`, `npx vitest run`/
  )
})

test('off mode leaves even a red claim alone', async ($, on) => {
  const w = world(on, [], { ...HARNU, HARNU_VERIFY_GATE: 'off' })
  await edit($)
  await bash($, 'npm run typecheck', 'Exit code 1')
  const r = await $.tool.call(CLAIM)
  expect(r.deny).toBeUndefined()
  expect(r.context).toBeUndefined()
  expect(w.reached).toEqual(['mcp__harnu__mission_update_step'])
})

test('outside Harnu the default is annotate, and nothing runs', async ($, on) => {
  const w = world(on, [], {})
  await edit($)
  const r = await $.tool.call(CLAIM)
  expect(w.runs).toEqual([])
  expect(r.context?.at(-1)).toMatch(/no check is configured/)
})

test(
  'outside Harnu, enforce runs only the userConfig check',
  { options: { mode: 'enforce', check: 'make test' } },
  async ($, on) => {
    const w = world(on, [{ code: 1, output: 'FAIL' }], {})
    await edit($)
    const r = await $.tool.call(CLAIM)
    expect(w.runs).toEqual(['make test'])
    expect(r.deny).toMatch(/`make test` failed after the last edit \(run by the gate\)/)
  }
)

test('a resumed session is treated as edited: its first claim checks', async ($, on) => {
  const w = world(on, [{ code: 0 }, { code: 0 }])
  await $.classic.SessionStart({ source: 'resume' })
  const r = await $.tool.call(CLAIM)
  expect(w.runs).toEqual(PARTS)
  expect(r.deny).toBeUndefined()
})

test('a completion report sent to another session carries the receipt line', async ($, on) => {
  const w = world(on, [])
  /** The model's own SendMessage, as `session.send` sees it. */
  const send = (text: string) =>
    $.session.send({ to: 'orchestrator', text, origin: { kind: 'model' } })
  await send('Done: spec written.')
  await edit($)
  await send('Progress: half way.')
  await send('Done: all tests pass.')
  expect(w.sent[0]).toBe('Done: spec written.')
  expect(w.sent[1]).toBe('Progress: half way.')
  expect(w.sent[2]).toMatch(
    /^Done: all tests pass\.\n\n\[verify-gate\] this report: no green run since the last edit/
  )
  expect(w.runs).toEqual([])
})

test('message_session asks for a re-send with the receipt line, and passes once it is there', async ($, on) => {
  const w = world(on, [])
  await edit($)
  await bash($, 'npm run typecheck && npx vitest run')
  const msg = {
    tool: 'mcp__harnu__message_session',
    sessionId: 'abc',
    message: 'Done, PR is up.'
  } as const
  const first = await $.tool.call(msg)
  expect(first.deny).toMatch(
    /send it again with this line appended, as written:\n\[verify-gate\] `npx vitest run` passed \(run by this session\)/
  )
  const line = first.deny!.split('\n')[1]!
  const second = await $.tool.call({ ...msg, message: `Done, PR is up.\n${line}` })
  expect(second.deny).toBeUndefined()
  expect(w.reached).toEqual(['mcp__harnu__message_session'])
})

test('a "done" reply with no green check since the last edit is annotated', async ($, on) => {
  world(on, [])
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  await edit($)
  const done = {
    answer: 'Done, all tests pass.',
    reason: 'answer',
    durationMs: 10,
    isAborted: false,
    turnId: 't1'
  } as const
  expect((await $.turn.complete(done)).text).toMatch(/^⚠ verify-gate: this reply claims completion/)
  await bash($, 'npm run typecheck && npx vitest run')
  expect((await $.turn.complete(done)).text).toBe('Done, all tests pass.')
})

const ONE = { ...HARNU, HARNU_VERIFY_CMD: JSON.stringify(['sh check.sh']) }

for (const shape of [
  'sh check.sh 2>&1 | tail -5',
  'sh check.sh || true',
  'sh check.sh; rm -r x',
  'sh check.sh || echo failed',
  'sh check.sh; echo done'
]) {
  test(`\`${shape}\` exiting 0 is no receipt: the gate runs the part itself`, async ($, on) => {
    const w = world(on, [{ code: 1, output: 'check-red' }], ONE)
    await edit($)
    await bash($, shape)
    const r = await $.tool.call(CLAIM)
    expect(w.runs).toEqual(['sh check.sh'])
    expect(r.deny).toMatch(
      /`sh check.sh` failed after the last edit \(run by the gate\)[\s\S]*check-red/
    )
  })
}

test('control: the bare part exiting 0 is a receipt; a later `; rm -r x` is an edit', async ($, on) => {
  const w = world(on, [{ code: 0 }], ONE)
  await edit($)
  await bash($, 'sh check.sh > /dev/null 2>&1')
  expect((await $.tool.call(CLAIM)).deny).toBeUndefined()
  expect(w.runs).toEqual([])
  await bash($, 'ls; rm -r x')
  await $.tool.call(CLAIM)
  expect(w.runs).toEqual(['sh check.sh'])
})

test('a write through `>` is an edit; `cd elsewhere && <part>` is no receipt and no edit', async ($, on) => {
  const w = world(on, [{ code: 0 }, { code: 0 }], ONE)
  await edit($)
  await bash($, 'sh check.sh')
  await bash($, 'echo hi > notes.txt')
  await $.tool.call(CLAIM)
  expect(w.runs).toEqual(['sh check.sh'])
  await bash($, 'cat > other.txt')
  await bash($, 'cd /elsewhere && sh check.sh')
  await $.tool.call(CLAIM)
  expect(w.runs).toEqual(['sh check.sh', 'sh check.sh'])
})

test("a part this session's permissions would ask about is not run: the session runs it", async ($, on) => {
  const w = world(on, [], HARNU, { partVerdict: 'ask' })
  await edit($)
  const r = await $.tool.call(CLAIM)
  expect(w.asked).toEqual(['npm run typecheck'])
  expect(w.runs).toEqual([])
  expect(r.deny).toMatch(
    /could not run `npm run typecheck` \(this session's permissions would ask before running it\)\. Run it yourself with Bash/
  )
})

for (const source of ['project', 'local'] as const) {
  test(`HARNU_VERIFY_* in the ${source} settings sets Harnu's parts aside`, async ($, on) => {
    const settings = { [source]: { env: { HARNU_VERIFY_CMD: '["node -e 1"]' } } }
    const w = world(on, [], HARNU, { settings })
    await edit($)
    const r = await $.tool.call(CLAIM)
    expect(w.runs).toEqual([])
    expect(r.context?.at(-1)).toMatch(
      new RegExp(`HARNU_VERIFY_\\* is set in the ${source} settings`)
    )
  })
}

test('parts approved for another folder are set aside', async ($, on) => {
  const w = world(on, [], { ...HARNU, HARNU_VERIFY_ROOT: '/repo/other-wt' })
  await edit($)
  const r = await $.tool.call(CLAIM)
  expect(w.runs).toEqual([])
  expect(r.context?.at(-1)).toMatch(/the approved command belongs to another folder/)
})

test('a receipt line copied from an earlier report does not count', async ($, on) => {
  const w = world(on, [], ONE)
  await edit($)
  await bash($, 'sh check.sh')
  const msg = {
    tool: 'mcp__harnu__message_session',
    sessionId: 'abc',
    message: 'Done, PR is up.'
  } as const
  const old = (await $.tool.call(msg)).deny!.split('\n')[1]!
  await edit($, 'src/b.ts')
  const r = await $.tool.call({ ...msg, message: `Done, PR is up.\n${old}` })
  expect(r.deny).toMatch(
    /send it again with this line appended, as written:\n\[verify-gate\] this report: no green run since the last edit \(Edit src\/b.ts\)/
  )
  expect(w.reached).toEqual([])
})

// ---- Round 4: the classifier is a strict allowlist (spec §6.2) ----

const EVASIONS = [
  'sh check.sh && sh check.sh again & true',
  'sh check.sh && sh check.sh again\ntrue',
  'sh check.sh && sh check.sh again\r\ntrue',
  'sh check.sh x & rm -rf src',
  'sh check.sh $(rm -rf src)',
  'sh check.sh `rm -rf src`',
  'sh check.sh <(rm -rf src)',
  '(sh check.sh)',
  '{ sh check.sh; }',
  'sh check.sh && true'
]

for (const shape of EVASIONS) {
  test(`${JSON.stringify(shape)} is no receipt: the gate runs the part itself`, async ($, on) => {
    const w = world(on, [{ code: 1, output: 'check-red' }], ONE)
    await edit($)
    await bash($, shape)
    const r = await $.tool.call(CLAIM)
    expect(w.runs).toEqual(['sh check.sh'])
    expect(r.deny).toMatch(
      /`sh check.sh` failed after the last edit \(run by the gate\)[\s\S]*check-red/
    )
  })
}

test('an honest shape with a trailing echo records nothing green: both parts re-run', async ($, on) => {
  const w = world(on, [{ code: 0 }, { code: 0 }])
  await edit($)
  await bash($, 'npm run typecheck && npx vitest run --reporter=dot\necho "exit=$?"')
  await $.tool.call(CLAIM)
  expect(w.runs).toEqual(PARTS)
})

test('parts joined only by && with neutral commands are a receipt', async ($, on) => {
  const w = world(on, [], ONE)
  await edit($)
  await bash($, 'git status && sh check.sh 2>&1 && git diff --stat > /dev/null')
  const r = await $.tool.call(CLAIM)
  expect(w.runs).toEqual([])
  expect(r.deny).toBeUndefined()
})

test('a narrower run of a part joined to the part is no receipt for either', async ($, on) => {
  const w = world(on, [{ code: 0 }, { code: 0 }])
  await edit($)
  await bash($, 'npm run typecheck && npx vitest run tests/a.test.ts')
  await $.tool.call(CLAIM)
  expect(w.runs).toEqual(PARTS)
})

/** One row per shell metacharacter: none may turn a failing run into a receipt, none may hide a write. */
const METACHARS: Record<string, string> = {
  'lone &': '&',
  semicolon: ';',
  pipe: '|',
  'double pipe': '||',
  'triple &': '&&&',
  newline: '\n',
  'carriage return': '\r',
  backtick: '`',
  'command substitution': '$(',
  'process substitution': '<(',
  'open paren': '(',
  'close paren': ')',
  'input redirect': '<',
  'output redirect': '>',
  'append redirect': '>>',
  'open brace': '{',
  'close brace': '}',
  backslash: '\\',
  'dollar sign': '$'
}

for (const [name, c] of Object.entries(METACHARS)) {
  test(`metacharacter ${name}: \`sh check.sh ${JSON.stringify(c)} true\` is never a receipt`, async ($, on) => {
    const w = world(on, [{ code: 1, output: 'check-red' }], ONE)
    await edit($)
    await bash($, `sh check.sh ${c} true`)
    const r = await $.tool.call(CLAIM)
    expect(w.runs).toEqual(['sh check.sh'])
    expect(r.deny).toMatch(/failed after the last edit \(run by the gate\)/)
  })

  test(`metacharacter ${name}: after a green receipt, \`sh check.sh x ${JSON.stringify(c)}rm -rf src\` is an edit`, async ($, on) => {
    const w = world(on, [{ code: 0 }], ONE)
    await edit($)
    await bash($, 'sh check.sh')
    expect((await $.tool.call(CLAIM)).deny).toBeUndefined()
    expect(w.runs).toEqual([])
    await bash($, `sh check.sh x ${c}rm -rf src`)
    await $.tool.call(CLAIM)
    expect(w.runs).toEqual(['sh check.sh'])
  })
}

// ---- Round 4: every settings source, and the merge (spec §7.6 b) ----

for (const source of ['user', 'flag', 'policy'] as const) {
  test(`HARNU_VERIFY_* in the ${source} settings sets Harnu's parts aside`, async ($, on) => {
    const settings = { [source]: { env: { HARNU_VERIFY_CMD: '["node -e 1"]' } } }
    const w = world(on, [], HARNU, { settings })
    await edit($)
    const r = await $.tool.call(CLAIM)
    expect(w.runs).toEqual([])
    expect(r.context?.at(-1)).toMatch(
      new RegExp(`HARNU_VERIFY_\\* is set in the ${source} settings`)
    )
  })
}

test('a hit visible only in the merged read still sets the parts aside', async ($, on) => {
  const w = world(on, [], HARNU, { merged: { env: { HARNU_VERIFY_GATE: 'off' } } })
  await edit($)
  const r = await $.tool.call(CLAIM)
  expect(w.runs).toEqual([])
  expect(r.context?.at(-1)).toMatch(/HARNU_VERIFY_\* is set in the merged settings/)
})
```

## The stand-in MCP server (R2, R8)

`server.mjs`, run with `node server.mjs <log path>`:

```js
// A stand-in for Harnu's MCP server: one verb, mission_update_step, that records what reached it.
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const LOG = process.argv[2]
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
const TOOL = {
  name: 'mission_update_step',
  description: 'Edit one Mission step. set may carry proof: claimed.',
  inputSchema: {
    type: 'object',
    properties: {
      folder: { type: 'string' },
      missionId: { type: 'string' },
      stepId: { type: 'string' },
      set: { type: 'object' }
    },
    required: ['folder', 'missionId', 'stepId', 'set']
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line)
  if (msg.id === undefined) return
  if (msg.method === 'initialize')
    return send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: msg.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'harnu', version: '0.0.0' }
      }
    })
  if (msg.method === 'tools/list')
    return send({ jsonrpc: '2.0', id: msg.id, result: { tools: [TOOL] } })
  if (msg.method === 'tools/call') {
    appendFileSync(LOG, JSON.stringify(msg.params) + '\n')
    return send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { content: [{ type: 'text', text: '{"ok":true,"stepId":"stp-2"}' }], isError: false }
    })
  }
  send({ jsonrpc: '2.0', id: msg.id, result: {} })
})
```

## Gaps against the spec

| Spec              | Not in the prototype                                                                                                                                                                                                        |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §5.1 rows 3, 4, 8 | `mission_request_close` and `mission_verify_step` notes (W1); noun events (W3)                                                                                                                                              |
| §8.1              | Single-flight for racing claims                                                                                                                                                                                             |
| §7.2, §7.6, §11   | Everything on Harnu's side: the resolver key (D-1), the approval store and its disclosure, the spawn env **including deleting inherited values and setting the root**, the durable per-session mode and its re-key, staging |
| §10.2             | The gate's `api-surface.json`, CLI ceiling and static profile                                                                                                                                                               |
| §9.3              | Every Mission write, and the HEAD sha in the receipt (W3)                                                                                                                                                                   |
| §7.6 a            | Any answer to a blocking `PreToolUse` hook (a query consults none): stated, not closed (Q14)                                                                                                                                |
