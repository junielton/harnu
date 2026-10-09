# T452 — Prototype: `harnu-verify-gate` (C-5)

**Part of:** [`00-spec.md`](00-spec.md) · **Card:** T452 · **Status:** specified (not implemented) ·
**Round 2**

The minimal hooks module for the core mechanism:

- the ledger (spec §6);
- the judgement (§5.2);
- the policy read from Harnu's spawn env, or the person's userConfig outside Harnu (§7.2);
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
  ❯ ./register.ts calls: $.clock.after (via runPart), $.clock.now (via record), $.env.get (via policy), $.process.spawn (via runPart), $.session.root (via runPart), $.state.get, $.state.set, $.ui.status (via judge)
  ❯ ./register.ts env writes: nothing
  ❯ ./register.ts env reads: HARNU_VERIFY_CMD, HARNU_VERIFY_GATE
  ❯ ./register.ts state writes: harnu-verify-gate.ledger
  ❯ ./register.ts state reads: harnu-verify-gate.ledger

✔ Validation passed
```

`claude plugin test .`:

```

tests/gate.test.ts:
(pass) a claim from a session that edited nothing passes untouched [42.71ms]
(pass) inside Harnu, a claim after an edit runs each approved part in order; green passes with a receipt [22.45ms]
(pass) a red part refuses the claim, says the gate ran it, stops there, and never reaches the verb [17.17ms]
(pass) the working tree cannot choose the command: nothing approved means nothing runs [14.07ms]
(pass) the session's own runs count part by part, as separate Bash calls: nothing reruns [17.38ms]
(pass) only the part the session did not run is run by the gate [15.66ms]
(pass) a focused run is no receipt and no edit; an unknown command is an edit [19.42ms]
(pass) the session's own red run refuses the claim without a rerun, and says who ran it [14.09ms]
(pass) an edit after a green check makes it stale; neutral git commands do not [18.58ms]
(pass) gh pr create: a query runs nothing; a draft is never gated; a red receipt is denied at tool.check [15.69ms]
(pass) move_card to review is gated, to backlog is not; the legacy capy name is gated too [15.19ms]
(pass) a part that outlives the timeout is stopped, recorded as nothing, and handed back to the session [527.12ms]
(pass) annotate mode lets a stale claim through with a warning and runs nothing [24.53ms]
(pass) off mode leaves even a red claim alone [20.64ms]
(pass) outside Harnu the default is annotate, and nothing runs [16.46ms]
(pass) outside Harnu, enforce runs only the userConfig check [14.05ms]
(pass) a resumed session is treated as edited: its first claim checks [16.52ms]
(pass) a completion report sent to another session carries the receipt line [18.38ms]
(pass) message_session asks for a re-send with the receipt line, and passes once it is there [19.46ms]
(pass) a "done" reply with no green check since the last edit is annotated [12.84ms]

 20 pass
 0 fail
Ran 20 tests across 1 file. [1.00s]
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

Every test's `world` answers `fs.read` by throwing, so any test in which the gate reads a file
fails. All 20 pass: the gate reads no file.

**What the round-2 runs caught on the way**, each now fixed in the source below:

1. A streaming bottom hook in the kit must **return `{ value: { code, signal } }`**, not the bare
   result ("test's process.spawn hook was skipped: returned neither { value } nor { deny }").
2. A stream ended by the timer's `return()` **resolves `{ done: true, value: undefined }`**, so
   reading `step.value.code` crashed. `runPart` now checks `timedOut` first.
3. The kit types `$.session.send` with the event's own input, so a test must pass
   `origin: { kind: 'model' }` (TS2345 otherwise).
4. **Negative control.** The trust test "the working tree cannot choose the command" was flipped to
   expect a run of `touch PWNED`. The kit reported `(fail) the working tree cannot choose the
command: nothing approved means nothing runs`, 19 pass / 1 fail.

Round 1's own catches still hold: `$` only to top-level functions; the list matcher for a one-of;
`$.tool.check` in the kit is a query (`ToolCheckArgs` = `tool` + `input`, TYPES:12796), so the
real-call run path is shown live.

## Live runs of the round-2 prototype

Each ran `claude -p --model haiku --plugin-dir <mod>` (R5: interactive, under tmux) in a fresh
throwaway git repo in the scratchpad. **Inside-Harnu runs set the two variables Harnu would set at
spawn**: `HARNU_VERIFY_GATE=enforce` and `HARNU_VERIFY_CMD=<approved parts as JSON>`. The model
was asked to write or edit a file, then make a claim, then quote what came back. This machine has
a settings `PreToolUse` hook that rewrites `gh …` to `rtk gh …` before `tool.check` sees it; the
gate's unanchored regex still matches, which is why the quotes read `rtk gh pr ready 999`.

The sources were formatted with this repo's Prettier after these runs, which changed whitespace
only. P-K above was re-run on exactly the bytes pasted below.

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

| Id   | By                    | What it showed                                                                                                                                                                                                                                    |
| ---- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V-45 | T452 round-1 verifier | A 45 s check inside `tool.check` delivered its deny, 67 s wall, under `bypassPermissions`                                                                                                                                                         |
| V-A2 | T452 round-1 verifier | The session's own `sh check.sh`, exiting 1, arrived as `PostToolUseFailure`: the claim was denied with the tail `Exit code 1 / first-run-red-by-session`, and nothing re-ran                                                                      |
| V-A3 | T452 round-1 verifier | After a green run, a background `Agent` wrote `sub.txt`; `gh pr ready` re-ran the check (tail `second-run-red-gate-reran`). A subagent's edit reaches the parent's ledger                                                                         |
| V450 | T450 verifier         | On 2.1.296 headless, with `rtk` off, a pass-through Bash `tool.call` hook (`b4-mod4`: "[tool.call saw agent=aa141c36015a3312b]") left `Agent(isolation: "worktree")` intact: pwd and branch inside the agent's worktree, `made.txt` written there |

## `.claude-plugin/plugin.json`

```json
{
  "name": "harnu-verify-gate",
  "version": "0.2.0",
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
type Policy = { mode: 'off' | 'annotate' | 'enforce'; parts: string[]; inHarnu: boolean }

type Verdict =
  | { kind: 'not-author' }
  | { kind: 'no-check'; inHarnu: boolean }
  | { kind: 'green'; run: CheckRun }
  | { kind: 'red'; run: CheckRun }
  | { kind: 'stale'; parts: string[]; lastEdit: string }
  | { kind: 'unrun'; part: string; why: string }
  | { kind: 'aborted' }

const TAIL_LINES = 40
const TAIL_CHARS = 3_000
const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit']
const PR_CLAIM = /\bgh\s+pr\s+(create|ready)\b/
const DRAFT = /\s(--draft|-d)(\s|$)/
const DONE_WORDS = /\b(done|completed?|finished|all tests pass(ed)?|ready for review)\b/i
const RECEIPT_MARK = '[verify-gate]'
const NEUTRAL =
  /^\s*(git\s+(status|log|diff|show|add|commit|push|fetch|rev-parse|rev-list|branch)\b|gh\s|ls\b|cat\b|head\b|tail\b|wc\b|rg\b|grep\b|pwd\b|echo\b)/
const SEGMENT = /&&|\|\||;|\|/
const MODES = ['off', 'annotate', 'enforce']

const tailOf = (text: string): string =>
  text.split('\n').slice(-TAIL_LINES).join('\n').slice(-TAIL_CHARS)

const REDIRECT = /(\s+\d*[<>]&?\s*\S+)+$/

/** A command's segments, split at `&&`, `||`, `;` and `|`, each without trailing redirections. */
const segments = (command: string): string[] =>
  command
    .split(SEGMENT)
    .map((s) => s.trim().replace(REDIRECT, ''))
    .filter((s) => s !== '')

const isNeutral = (command: string): boolean => segments(command).every((s) => NEUTRAL.test(s))

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
 * Inside Harnu (`HARNU_VERIFY_GATE` set at spawn) the mode and the operator-approved parts come
 * from the spawn's env; nothing in the working tree is read. Outside Harnu, the person's
 * userConfig. The model can write neither (§7.3).
 */
async function policy($: EngineInterface, opts: Options): Promise<Policy> {
  const mode = await $.env.get('HARNU_VERIFY_GATE')
  if (mode !== undefined) {
    return {
      mode: asMode(mode),
      parts: parseParts(await $.env.get('HARNU_VERIFY_CMD')),
      inHarnu: true
    }
  }
  const check = opts.check.trim()
  return { mode: asMode(opts.mode), parts: check === '' ? [] : [check], inHarnu: false }
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

/** One finished tool call into the ledger: an edit, a run of one or more check parts, or neither (§6.2). */
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
  const p = await policy($, opts)
  const segs = segments(command)
  // A part counts only when a segment IS the part: `npx vitest run tests/a.test.ts` is no receipt.
  const parts = p.parts.filter((part) => segs.includes(part))
  // A narrower run of a part (the part plus arguments) changes nothing: neither receipt nor edit.
  const narrower = segs.every(
    (s) => NEUTRAL.test(s) || p.parts.some((part) => s.startsWith(`${part} `))
  )
  if (parts.length > 0) {
    // A background run reports before the check finishes: never a receipt, never an edit.
    if (field(response, 'backgroundTaskId') !== '') return bump($)
    await record($, parts, { ok, by: 'session', tail: tailOf(output) })
  } else if (narrower || isNeutral(command)) {
    await bump($)
  } else {
    await bump($, `Bash: ${command.trim().slice(0, 80)}`)
  }
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
  if (p.parts.length === 0) return { kind: 'no-check', inHarnu: p.inHarnu }
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
          ? `${RECEIPT_MARK} ${claim}: this repo has no operator-approved verify command; this claim is unverified.`
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

/** The receipt line a completion report carries; never runs anything (§5.1 rows 7 and 12). */
async function receiptLine(
  $: EngineInterface,
  opts: Options,
  text: string
): Promise<string | undefined> {
  if (!DONE_WORDS.test(text) || text.includes(RECEIPT_MARK)) return undefined
  const w = wording(await judge($, opts, false, new AbortController().signal), 'this report')
  if (w === undefined) return undefined
  return 'deny' in w ? w.deny.split('\n')[0] : w.note
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

/**
 * The engine beneath the gate. `env` stands for what Harnu sets at spawn; `outcomes` answer each
 * spawned part in order. Every `fs.read` fails the test: the gate never reads the working tree.
 */
const world = (
  on: On,
  outcomes: Outcome[],
  env: Record<string, string> = {
    HARNU_VERIFY_GATE: 'enforce',
    HARNU_VERIFY_CMD: JSON.stringify(PARTS)
  }
) => {
  const clock = mock.clock(on, { now: 1_000 })
  mock.env(on, env)
  const runs: string[] = []
  const reached: string[] = []
  const sent: string[] = []
  on('fs.read', (_$, e) => {
    throw new Error(`the gate read a file: ${JSON.stringify(e)}`)
  })
  on('session.root', () => ({ value: '/repo/wt' }))
  on('ui.status', () => ({ value: undefined }))
  on('process.spawn', async function* (_$, e) {
    runs.push(String(e.argv[2]))
    const o = outcomes[runs.length - 1] ?? { code: 0 }
    if (o === 'hang') {
      for (;;) {
        await clock.sleep(1_000)
        yield { stream: 'stdout' as const, text: '.' }
      }
    }
    if (o.output !== undefined) yield { stream: 'stdout' as const, text: o.output }
    return { value: { code: o.code, signal: null } }
  })
  on('tool.call', (_$, e) => {
    reached.push(String(e.tool))
    return { result: { ok: true } } as never
  })
  on('tool.check', () => ({ decision: 'allow' as const }))
  on('session.send', (_$, e) => {
    sent.push(e.text)
    return { isDelivered: true as const }
  })
  on('classic.PostToolUse', () => ({}))
  on('classic.PostToolUseFailure', () => ({}))
  on('classic.SessionStart', () => ({}))
  return { clock, runs, reached, sent }
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
  const w = world(on, [], { HARNU_VERIFY_GATE: 'enforce' })
  await edit($)
  await edit($, 'WORKTREE.md')
  const r = await $.tool.call(CLAIM)
  expect(r.deny).toBeUndefined()
  expect(w.runs).toEqual([])
  expect(r.context?.at(-1)).toMatch(/no operator-approved verify command; this claim is unverified/)
})

test("the session's own runs count part by part, as separate Bash calls: nothing reruns", async ($, on) => {
  const w = world(on, [])
  await edit($)
  await bash($, 'npm run typecheck')
  await bash($, 'npx vitest run 2>&1 | tail -40')
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
  const w = world(on, [], {
    HARNU_VERIFY_GATE: 'annotate',
    HARNU_VERIFY_CMD: JSON.stringify(PARTS)
  })
  await edit($)
  const r = await $.tool.call(CLAIM)
  expect(r.deny).toBeUndefined()
  expect(w.runs).toEqual([])
  expect(r.context?.at(-1)).toMatch(
    /no green run since the last edit \(Edit src\/a.ts\)\. Run `npm run typecheck`, `npx vitest run`/
  )
})

test('off mode leaves even a red claim alone', async ($, on) => {
  const w = world(on, [], { HARNU_VERIFY_GATE: 'off', HARNU_VERIFY_CMD: JSON.stringify(PARTS) })
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
```

## The stand-in MCP server (R2)

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

| Spec              | Not in the prototype                                                                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| §5.1 rows 3, 4, 8 | `mission_request_close` and `mission_verify_step` notes (W1); noun events (W3)                                                                  |
| §8.1              | Single-flight for racing claims                                                                                                                 |
| §7.2, §11         | Everything on Harnu's side: the resolver key (D-1), the approval store and its disclosure, the spawn env, the durable per-session mode, staging |
| §10.2             | The gate's `api-surface.json`, CLI ceiling and static profile                                                                                   |
| §9.3              | Every Mission write, and the HEAD sha in the receipt (W3)                                                                                       |
