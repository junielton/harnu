# T452 — Prototype: `harnu-verify-gate` (C-5)

**Part of:** [`00-spec.md`](00-spec.md) · **Card:** T452 · **Status:** specified (not implemented)

The minimal hooks module for the core mechanism: the ledger (spec §6), the judgement (§5.2), the
check run (§8), and the claims of §5.1 rows 1, 2, 5 and 9. The files below were written in the
session scratchpad (never under `src/` or `resources/`) and checked on 2026-10-09.

What it leaves to W1 (spec §13) is listed under [Gaps](#gaps-against-the-spec).

## Runs

Versions: types written by Claude Code **2.1.295**'s `plugin-authoring` skill; the `claude` binary
on `PATH` reported `2.1.296 (Claude Code)`; TypeScript `5.9.3` from this repo's `node_modules`.
Paths are shortened to `<scratch>` (the session scratchpad) and `<skill>` (the skill's folder).

### P-K — `claude plugin validate`, `claude plugin test`, `tsc`

`claude plugin validate .`:

```
Validating plugin manifest: <scratch>/harnu-verify-gate/.claude-plugin/plugin.json

  ❯ types ./types/index.d.ts declares on $: nothing (no EngineInterface member)
  ❯ types ./types/index.d.ts declares state: harnu-verify-gate.ledger

Validating hooks: <scratch>/harnu-verify-gate/hooks/hooks.json

  ❯ ./register.ts hooks: classic.PostToolUse, classic.PostToolUseFailure, tool.check{tool=Bash}, tool.call{tool=mcp__harnu__mission_update_step|mcp__capy__mission_update_step}, tool.call{tool=mcp__harnu__move_card|mcp__capy__move_card}, turn.complete
  ❯ ./register.ts gating hook with .catch: classic.PostToolUse
  ❯ ./register.ts gating hook with .catch: classic.PostToolUseFailure
  ❯ ./register.ts gating hook with .catch: tool.check{tool=Bash}
  ❯ ./register.ts gating hook with .catch: tool.call{tool=mcp__harnu__mission_update_step|mcp__capy__mission_update_step}
  ❯ ./register.ts gating hook with .catch: tool.call{tool=mcp__harnu__move_card|mcp__capy__move_card}
  ❯ ./register.ts calls: $.clock.now (via record), $.fs.read (via resolveCheck), $.process.run (via judge), $.session.root (via judge), $.state.get, $.state.set
  ❯ ./register.ts state writes: harnu-verify-gate.ledger
  ❯ ./register.ts state reads: harnu-verify-gate.ledger

✔ Validation passed
```

`claude plugin test .`:

```

tests/gate.test.ts:
(pass) a claim from a session that edited nothing passes untouched [29.08ms]
(pass) a claim after an edit runs the check, and a green run passes it with a receipt [16.34ms]
(pass) a red check refuses the claim, carries the output tail, and never reaches the verb [13.35ms]
(pass) the session's own green run after its last edit is the receipt: nothing reruns [12.94ms]
(pass) the session's own red run after its last edit refuses the claim without a rerun [12.26ms]
(pass) an edit after the check makes it stale; neutral git commands do not [15.11ms]
(pass) an unknown Bash command counts as an edit [12.77ms]
(pass) gh pr create on a stale tree: a query runs nothing and lets it through; a draft is never gated [11.95ms]
(pass) gh pr ready after the session's own red run is denied at tool.check, with the tail [11.77ms]
(pass) the legacy capy server name is gated the same way [11.47ms]
(pass) move_card to review is gated; to backlog is not [12.07ms]
(pass) a check the gate cannot finish refuses and hands the run back to the session [12.69ms]
(pass) annotate mode lets a stale claim through with a warning and runs nothing [9.89ms]
(pass) a "done" reply with no green check since the last edit is annotated [11.97ms]

 14 pass
 0 fail
Ran 14 tests across 1 file. [0.31s]
```

`tsc -p <scratch>/tsc` (the header's `tsconfig.json`, kept outside the mod folder, as SKILL.md
says for a mod the engine has not loaded): no output, **exit 0**.

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

**What the runs caught on the way.** Each is a fix now in the source below.

1. The first `validate` **failed**: "`$` is passed to "bump", which is not a function declared at
   the top of this file". `$` may only be handed to top-level functions, so every helper that takes
   `$` is a top-level `async function`, and the options travel in a `Config` object.
2. The first `tsc` failed twice. A `{ tool }` matcher built in a `for` loop over a `const` tuple
   does not type (TS2345, and TS2589 "excessively deep"); the one-of list matcher
   `{ tool: ['Edit', 'Write', 'NotebookEdit'] }` does (TYPES:5842-5850). A hook answer typed as a
   bare `{ context }` is not a `ToolCallResult`, so the helpers return `ToolCallResult` and spread
   the result from `next`.
3. **The first prototype hooked `tool.call` on Bash.** SMOKE:628-650 (B4) shows that even a
   pass-through `tool.call` on Bash breaks `Agent(isolation: "worktree")`. The Bash claim moved to
   `tool.check`, and the ledger moved to `classic.PostToolUse` / `PostToolUseFailure` for all four
   tools. P4 below shows isolation intact with this shape.
4. `$.tool.check` in the kit is a **query**: `ToolCheckArgs` is `tool` + `input` only
   (TYPES:12796), so no `tool_use_id` can be passed. The kit therefore covers the query path (no
   run, judged from the ledger alone) and a deny from a red receipt. The real-call path, where the
   gate runs the check inside `tool.check`, is shown live in P1 and P3.
5. A **negative control** was run on the first suite: the red-check test was flipped to expect no
   deny, and the kit reported `(fail) a red check refuses the claim and carries the output tail`,
   10 pass / 1 fail. The suite does fail when the gate misbehaves.

### Live runs, `claude -p --plugin-dir <mod>`

Each ran in a fresh throwaway git repo in the scratchpad, model `haiku`, with a `WORKTREE.md` whose
front matter holds the `verify:` key. The model was asked to write a file, then run `gh pr ready
999`, then quote what the tool returned. This machine has a settings `PreToolUse` hook that
rewrites `gh …` to `rtk gh …` before `tool.check` sees it. The gate's unanchored regex still
matched, which is why the quoted command reads `rtk gh pr ready 999`.

**P1 — a red check denies a real `gh pr ready` at `tool.check`.** `verify: echo
boom-from-check; exit 1`. Final shape. The model quoted:

```
Permission to use Bash denied by plugin harnu-verify-gate: [verify-gate] `rtk gh pr ready 999` refused: `echo boom-from-check; exit 1` failed after the last edit. Fix it, run it again, then claim. Output tail:
boom-from-check
```

This shows, live: the `Write` reached the ledger through `classic.PostToolUse` (otherwise rule A
would have passed the call); `$.fs.read('WORKTREE.md')` and `$.session.root()` resolved; the gate
ran the check through `$.process.run` on a real call (`tool_use_id` present); and the deny reached
the model in the `Permission to use Bash denied by plugin …` form P3W2 recorded (T389/P3W2:50).

**P2 — a green check lets the claim through, and the receipt reaches the model.** `verify: echo
all-green`. This run used the **first** prototype, whose Bash hook was `tool.call` (since removed,
point 3 above). It is kept as evidence for one mechanism the final shape still uses on MCP verbs:
a `context` note on a `tool.call` result reaches the model. The model quoted the note as "a hook
note … not part of the Bash output":

```
[verify-gate] `echo all-green` passed (run by the gate) after the last edit.
```

The call itself then stopped at the permission layer ("This command requires approval"), because
the `--allowedTools` pattern did not match the rewritten `rtk gh …` command. The gate had already
let it through.

**P3 — a check longer than the 10 s hook budget.** `verify: sleep 15; echo slow-check-red; exit
1`. Final shape. The deny arrived with the tail `slow-check-red`, and the whole `claude -p` run took
31 s. The budget clock stops while `$.process.run` is in flight (TYPES:5089-5104), so a long check
is not cut off as an overrun hook.

**P4 — worktree-isolated subagents still work (B4).** `--permission-mode bypassPermissions`, one
`Agent(subagent_type: "general-purpose", isolation: "worktree")` that runs `pwd && git branch
--show-current` and writes `probe.txt`. Final shape.

| Run                      | pwd seen by the agent                      | Worktree after (`git worktree list`)     | `probe.txt`                        |
| ------------------------ | ------------------------------------------ | ---------------------------------------- | ---------------------------------- |
| With `harnu-verify-gate` | `…/live2/.claude/worktrees/agent-aa6a80e…` | listed, branch `worktree-agent-aa6a80e…` | in the agent's worktree (`ls -la`) |
| Control, no mod          | `…/live3/.claude/worktrees/agent-a082ff2…` | listed, branch `worktree-agent-a082ff2…` | in the agent's worktree            |

In **both** runs the subagent's `git branch --show-current` was refused by the engine's worktree
check, because this machine's `rtk` rewrite wraps `git`. The control shows that refusal without the
mod, so it is the machine's hook, not the gate. B4's failure, "Worktree isolation was lost", did
not occur with the gate loaded.

The matcher change that added the legacy `mcp__capy__…` names came after P1, P3 and P4. It touches
only the MCP hooks, which `claude -p` cannot reach (no Harnu MCP server), so those runs still
describe the Bash and ledger paths of the final source. After that, the sources were formatted
with this repo's Prettier config, a whitespace-only change, and P-K above was re-run on exactly the
bytes pasted below.

**P5 and P6 — the Mission claim through an MCP server named `harnu`.** `claude -p` has no Harnu
MCP server, so these runs used a stand-in: a 40-line stdio MCP server, below, registered as
`harnu` with `--mcp-config … --strict-mcp-config`. It offers one verb, `mission_update_step`, and
appends every call it receives to a log. The model wrote a file, then called
`mcp__harnu__mission_update_step` with `set: { proof: 'claimed' }`. Final shape, both runs in
parallel in two fresh repos.

P5, `verify: echo mcp-check-red; exit 1`. The model quoted:

```
<tool_use_error>[verify-gate] claim on stp-2 refused: `echo mcp-check-red; exit 1` failed after the last edit. Fix it, run it again, then claim. Output tail:
mcp-check-red</tool_use_error>
```

The server's log stayed **empty**: the refused claim never reached it.

P6, `verify: echo mcp-check-green`. The model quoted:

```
{"ok":true,"stepId":"stp-2"}

tool.call hook additional context: [verify-gate] `echo mcp-check-green` passed (run by the gate) after the last edit.
```

The server logged one call with `"set":{"proof":"claimed"}`: the claim went through, and the
receipt reached the model beside the verb's own answer.

The quotes above are from the first P5/P6 run. After the server source was formatted with this
repo's Prettier (whitespace only), both runs were repeated on the bytes pasted below with the same
result: P5 refused with the same reason and an empty server log; P6 logged the claim, and the model
quoted the same `[verify-gate] … passed (run by the gate)` note.

The stand-in server (`server.mjs`, run with `node server.mjs <log path>`):

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

### What no run here covers

P5 and P6 used a stand-in server, not Harnu's. A real Harnu session (its server, its
`harnu.mcp.json`, "Ask before agent actions") is still W0 (spec §15, A1). So are A2-A5.

## `.claude-plugin/plugin.json`

```json
{
  "name": "harnu-verify-gate",
  "version": "0.1.0",
  "author": { "name": "Harnu" },
  "description": "Done means the check ran: gates a session's own completion claims on a fresh verification run.",
  "types": "./types/index.d.ts",
  "userConfig": {
    "mode": {
      "type": "string",
      "title": "Mode",
      "description": "enforce: refuse a red or unchecked claim; annotate: let it through with a warning; off: do nothing.",
      "default": "enforce",
      "options": ["enforce", "annotate", "off"]
    },
    "check": {
      "type": "string",
      "title": "Check command",
      "description": "POSIX command line run when no `verify:` key is found in WORKTREE.md. Empty: none.",
      "default": ""
    },
    "timeoutSeconds": {
      "type": "number",
      "title": "Check timeout (seconds)",
      "description": "How long the gate lets its own check run, 600 at most.",
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
/** One run of the check: the session's own Bash run, or the gate's. */
export type CheckRun = {
  /** Ledger position of the run; it counts when it is greater than `lastEditSeq`. */
  seq: number
  command: string
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
  lastCheck: CheckRun | null
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
    lastCheck: null
  } as Ledger
)

type Config = { mode: string; fallback: string; timeoutMs: number }

type Verdict =
  | { kind: 'not-author' }
  | { kind: 'no-check' }
  | { kind: 'green'; run: CheckRun }
  | { kind: 'red'; run: CheckRun }
  | { kind: 'stale'; command: string; lastEdit: string }
  | { kind: 'unrun'; command: string; why: string }

const TAIL_LINES = 40
const TAIL_CHARS = 3_000
const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit']
const PR_CLAIM = /\bgh\s+pr\s+(create|ready)\b/
const DRAFT = /\s(--draft|-d)(\s|$)/
const DONE_WORDS = /\b(done|completed?|finished|all tests pass(ed)?|ready for review)\b/i
const NEUTRAL =
  /^\s*(git\s+(status|log|diff|show|add|commit|push|fetch|rev-parse|rev-list|branch)\b|gh\s|ls\b|cat\b|head\b|tail\b|wc\b|rg\b|grep\b|pwd\b|echo\b)/
const SEGMENT = /&&|\|\||;|\|/

const tailOf = (text: string): string =>
  text.split('\n').slice(-TAIL_LINES).join('\n').slice(-TAIL_CHARS)

const isNeutral = (command: string): boolean =>
  command.split(SEGMENT).every((part) => part.trim() === '' || NEUTRAL.test(part))

const field = (value: unknown, key: string): string => {
  const v =
    typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)[key]
      : undefined
  return typeof v === 'string' ? v : ''
}

/** WORKTREE.md's `verify:` key: one line, or a `- item` list joined by `&&` (§7.2). */
const parseVerify = (manifest: string): string | undefined => {
  const front = /^---\n([\s\S]*?)\n---/.exec(manifest)?.[1]
  if (front === undefined) return undefined
  const lines = front.split('\n')
  const at = lines.findIndex((l) => /^verify:/.test(l))
  if (at < 0) return undefined
  const inline = lines[at]!.slice('verify:'.length).trim()
  if (inline !== '') return inline
  const items: string[] = []
  for (const l of lines.slice(at + 1)) {
    const item = /^\s+-\s+(.+)$/.exec(l)?.[1]
    if (item === undefined) break
    items.push(item.trim())
  }
  return items.length > 0 ? items.join(' && ') : undefined
}

async function resolveCheck($: EngineInterface, cfg: Config): Promise<string | undefined> {
  try {
    const fromManifest = parseVerify(await $.fs.read('WORKTREE.md'))
    if (fromManifest !== undefined) return fromManifest
  } catch {
    // no WORKTREE.md: the option, or nothing
  }
  return cfg.fallback === '' ? undefined : cfg.fallback
}

async function bump($: EngineInterface, edit?: string): Promise<void> {
  await update($, ledger, (l) =>
    edit === undefined
      ? { ...l, seq: l.seq + 1 }
      : { ...l, seq: l.seq + 1, lastEditSeq: l.seq + 1, lastEdit: edit }
  )
}

async function record($: EngineInterface, run: Omit<CheckRun, 'seq' | 'at'>): Promise<CheckRun> {
  const at = await $.clock.now()
  const next = await update($, ledger, (l) => ({
    ...l,
    seq: l.seq + 1,
    lastCheck: { ...run, seq: l.seq + 1, at }
  }))
  return next.lastCheck!
}

/** One finished tool call into the ledger: an edit, a check run, or neither (§6.2). */
async function observe(
  $: EngineInterface,
  cfg: Config,
  tool: string,
  input: unknown,
  ok: boolean,
  output: string
) {
  if (EDIT_TOOLS.includes(tool)) {
    if (ok) await bump($, `${tool} ${field(input, 'file_path') || field(input, 'notebook_path')}`)
    return
  }
  if (tool !== 'Bash') return
  const command = field(input, 'command')
  const check = await resolveCheck($, cfg)
  if (check !== undefined && command.includes(check)) {
    await record($, { command: check, ok, by: 'session', tail: tailOf(output) })
  } else if (isNeutral(command)) {
    await bump($)
  } else {
    await bump($, `Bash: ${command.trim().slice(0, 80)}`)
  }
}

/** Did a check run since this session's last edit, and was it green? Runs it when it may (§7). */
async function judge($: EngineInterface, cfg: Config, mayRun: boolean): Promise<Verdict> {
  const l = await read($, ledger)
  if (l.lastEditSeq === 0) return { kind: 'not-author' }
  if (l.lastCheck !== null && l.lastCheck.seq > l.lastEditSeq)
    return l.lastCheck.ok ? { kind: 'green', run: l.lastCheck } : { kind: 'red', run: l.lastCheck }
  const command = await resolveCheck($, cfg)
  if (command === undefined) return { kind: 'no-check' }
  if (cfg.mode === 'annotate' || !mayRun) return { kind: 'stale', command, lastEdit: l.lastEdit }
  let ran
  try {
    ran = await $.process.run(['sh', '-c', command], {
      cwd: await $.session.root(),
      timeoutMs: cfg.timeoutMs
    })
  } catch (err) {
    return { kind: 'unrun', command, why: err instanceof Error ? err.message : String(err) }
  }
  const run = await record($, {
    command,
    ok: ran.exitCode === 0,
    by: 'gate',
    tail: tailOf(`${ran.stdout}\n${ran.stderr}`.trim())
  })
  return run.ok ? { kind: 'green', run } : { kind: 'red', run }
}

/** The one-line answer for a verdict: a refusal, or a note that rides along (§5.2). */
function wording(v: Verdict, claim: string): { deny: string } | { note: string } | undefined {
  switch (v.kind) {
    case 'not-author':
      return undefined
    case 'no-check':
      return {
        note: `[verify-gate] ${claim}: no runnable check is configured; this claim is unverified.`
      }
    case 'green':
      return {
        note: `[verify-gate] \`${v.run.command}\` passed (${v.run.by === 'gate' ? 'run by the gate' : 'run by this session'}) after the last edit.`
      }
    case 'stale':
      return {
        note: `[verify-gate] ${claim}: no check ran since the last edit (${v.lastEdit}). Run \`${v.command}\`.`
      }
    case 'red':
      return {
        deny: `[verify-gate] ${claim} refused: \`${v.run.command}\` failed after the last edit. Fix it, run it again, then claim. Output tail:\n${v.run.tail}`
      }
    case 'unrun':
      return {
        deny: `[verify-gate] ${claim} refused: the gate could not run \`${v.command}\` (${v.why}). Run it yourself with Bash; a green run after your last edit counts.`
      }
  }
}

/** A Harnu verb claim at `tool.call`: refused when red or unrunnable, passed with a note otherwise. */
async function gateCall(
  $: EngineInterface,
  cfg: Config,
  claim: string,
  pass: () => Promise<ToolCallResult>
): Promise<ToolCallResult> {
  const w = wording(await judge($, cfg, true), claim)
  if (w !== undefined && 'deny' in w) return { deny: w.deny }
  const r = await pass()
  return w === undefined || r.deny !== undefined
    ? r
    : { ...r, context: [...(r.context ?? []), w.note] }
}

/** A Bash claim at `tool.check` (#92533: never `tool.call` on Bash). Only a real call may run a check. */
async function gateBash($: EngineInterface, cfg: Config, command: string, isRealCall: boolean) {
  const w = wording(await judge($, cfg, isRealCall), `\`${command.trim()}\``)
  return w !== undefined && 'deny' in w ? w.deny : undefined
}

async function staleDone($: EngineInterface): Promise<string | undefined> {
  const l = await read($, ledger)
  if (l.lastEditSeq === 0) return undefined
  if (l.lastCheck !== null && l.lastCheck.seq > l.lastEditSeq && l.lastCheck.ok) return undefined
  return `⚠ verify-gate: this reply claims completion, but no green check ran since the last edit (${l.lastEdit}).`
}

export const register: Register = (on, options) => {
  const cfg: Config = {
    mode: String(options.mode ?? 'enforce'),
    fallback: String(options.check ?? '').trim(),
    timeoutMs: Math.min(600, Math.max(1, Number(options.timeoutSeconds ?? 300))) * 1_000
  }
  if (cfg.mode === 'off') return

  // The ledger: every finished call of the four tools, main loop and subagents alike.
  on('classic.PostToolUse', async ($, e, next) => {
    const r = await next(e)
    const out = e.tool_response
    await observe(
      $,
      cfg,
      e.tool_name,
      e.tool_input,
      true,
      `${field(out, 'stdout')}\n${field(out, 'stderr')}`.trim()
    )
    return r
  }).catch(($, e, next) => next(e))

  on('classic.PostToolUseFailure', async ($, e, next) => {
    const r = await next(e)
    await observe($, cfg, e.tool_name, e.tool_input, false, e.error)
    return r
  }).catch(($, e, next) => next(e))

  // The claims.
  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    const r = await next(e)
    const command = field(e.input, 'command')
    if (r.decision === 'deny' || !PR_CLAIM.test(command) || DRAFT.test(command)) return r
    const deny = await gateBash($, cfg, command, e.tool_use_id !== undefined)
    return deny === undefined ? r : { decision: 'deny' as const, reason: deny }
  }).catch(($, e, next) => next(e))

  on(
    'tool.call',
    { tool: ['mcp__harnu__mission_update_step', 'mcp__capy__mission_update_step'] },
    async ($, e, next) => {
      const set = (e.set ?? {}) as Record<string, unknown>
      return set.proof === 'claimed'
        ? gateCall($, cfg, `claim on ${String(e.stepId)}`, () => next(e))
        : next(e)
    }
  ).catch(($, e, next) => next(e))

  on(
    'tool.call',
    { tool: ['mcp__harnu__move_card', 'mcp__capy__move_card'] },
    async ($, e, next) =>
      e.to === 'review'
        ? gateCall($, cfg, `move of ${String(e.slug)} to review`, () => next(e))
        : next(e)
  ).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.reason !== 'answer' || e.agentId !== undefined || !DONE_WORDS.test(r.text)) return r
    const warning = await staleDone($)
    return warning === undefined ? r : { ...r, text: warning }
  })
}
```

## `tests/gate.test.ts`

```ts
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const MANIFEST =
  '---\ndir: .claude/worktrees/{slug}\nverify:\n  - npm run typecheck\n  - npx vitest run\n---\n# Worktree\n'
const CHECK = 'npm run typecheck && npx vitest run'
const CLAIM = {
  tool: 'mcp__harnu__mission_update_step',
  folder: '/repo/wt',
  missionId: 'mnt-0000abcd',
  stepId: 'stp-2',
  set: { proof: 'claimed' }
} as const

/** The engine beneath the gate: a worktree with a WORKTREE.md, MCP verbs that succeed, a check runner. */
const world = (on: On, check: { exitCode: number; output?: string } | 'timeout') => {
  mock.clock(on, { now: 1_000 })
  const runs: string[][] = []
  const reached: string[] = []
  on('fs.read', () => ({ value: MANIFEST }))
  on('session.root', () => ({ value: '/repo/wt' }))
  on('process.run', (_$, e) => {
    runs.push([...e.argv])
    if (check === 'timeout') throw new Error('still running after 300000 ms')
    const out = check.output ?? ''
    return {
      value: {
        exitCode: check.exitCode,
        stdout: out,
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false
      }
    }
  })
  on('tool.call', (_$, e) => {
    reached.push(String(e.tool))
    return { result: { ok: true } } as never
  })
  on('tool.check', () => ({ decision: 'allow' as const }))
  on('classic.PostToolUse', () => ({}))
  on('classic.PostToolUseFailure', () => ({}))
  return { runs, reached }
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
/** `$.tool.check` in the kit is a query: no `tool_use_id`, so the gate never runs a check there (§11.1). */
const bashCheck = ($: Engine, command: string) => $.tool.check({ tool: 'Bash', input: { command } })

test('a claim from a session that edited nothing passes untouched', async ($, on) => {
  const w = world(on, { exitCode: 0 })
  const r = await $.tool.call(CLAIM)
  expect(r.deny).toBeUndefined()
  expect(w.runs).toEqual([])
  expect(w.reached).toEqual(['mcp__harnu__mission_update_step'])
})

test('a claim after an edit runs the check, and a green run passes it with a receipt', async ($, on) => {
  const w = world(on, { exitCode: 0 })
  await edit($)
  const r = await $.tool.call(CLAIM)
  expect(r.deny).toBeUndefined()
  expect(w.runs).toEqual([['sh', '-c', CHECK]])
  expect(r.context?.at(-1)).toMatch(
    /`npm run typecheck && npx vitest run` passed \(run by the gate\)/
  )
})

test('a red check refuses the claim, carries the output tail, and never reaches the verb', async ($, on) => {
  const w = world(on, { exitCode: 1, output: 'FAIL tests/a.test.ts\n  expected 2, got 3' })
  await edit($)
  const r = await $.tool.call(CLAIM)
  expect(r.deny).toMatch(/claim on stp-2 refused: .* failed after the last edit/)
  expect(r.deny).toMatch(/expected 2, got 3/)
  expect(w.reached).toEqual([])
})

test("the session's own green run after its last edit is the receipt: nothing reruns", async ($, on) => {
  const w = world(on, { exitCode: 1 })
  await edit($)
  await bash($, CHECK)
  const r = await $.tool.call(CLAIM)
  expect(r.deny).toBeUndefined()
  expect(w.runs).toEqual([])
  expect(r.context?.at(-1)).toMatch(/run by this session/)
})

test("the session's own red run after its last edit refuses the claim without a rerun", async ($, on) => {
  const w = world(on, { exitCode: 0 })
  await edit($)
  await bash($, CHECK, 'Exit code 2\nerror TS2322')
  const r = await $.tool.call(CLAIM)
  expect(w.runs).toEqual([])
  expect(r.deny).toMatch(/failed after the last edit[\s\S]*error TS2322/)
})

test('an edit after the check makes it stale; neutral git commands do not', async ($, on) => {
  const w = world(on, { exitCode: 0 })
  await edit($)
  await bash($, CHECK)
  await bash($, 'git add -A && git commit -m wip')
  await $.tool.call(CLAIM)
  expect(w.runs).toEqual([])
  await edit($, 'src/b.ts')
  await $.tool.call(CLAIM)
  expect(w.runs).toEqual([['sh', '-c', CHECK]])
})

test('an unknown Bash command counts as an edit', async ($, on) => {
  const w = world(on, { exitCode: 0 })
  await edit($)
  await bash($, CHECK)
  await bash($, "sed -i 's/a/b/' src/a.ts")
  await $.tool.call(CLAIM)
  expect(w.runs).toEqual([['sh', '-c', CHECK]])
})

test('gh pr create on a stale tree: a query runs nothing and lets it through; a draft is never gated', async ($, on) => {
  const w = world(on, { exitCode: 1 })
  await edit($)
  expect(await bashCheck($, 'gh pr create --base main --fill')).toMatchObject({ decision: 'allow' })
  expect(await bashCheck($, 'gh pr create --draft --fill')).toMatchObject({ decision: 'allow' })
  expect(w.runs).toEqual([])
})

test("gh pr ready after the session's own red run is denied at tool.check, with the tail", async ($, on) => {
  const w = world(on, { exitCode: 0 })
  await edit($)
  await bash($, CHECK, 'Exit code 1\nerror TS2345')
  const r = await bashCheck($, 'gh pr ready 12')
  expect(r.decision).toBe('deny')
  expect(r.reason).toMatch(/`gh pr ready 12` refused[\s\S]*TS2345/)
  expect(w.runs).toEqual([])
})

test('the legacy capy server name is gated the same way', async ($, on) => {
  world(on, { exitCode: 1 })
  await edit($)
  const r = await $.tool.call({ ...CLAIM, tool: 'mcp__capy__mission_update_step' })
  expect(r.deny).toMatch(/claim on stp-2 refused/)
})

test('move_card to review is gated; to backlog is not', async ($, on) => {
  world(on, { exitCode: 1 })
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
})

test('a check the gate cannot finish refuses and hands the run back to the session', async ($, on) => {
  world(on, 'timeout')
  await edit($)
  const r = await $.tool.call(CLAIM)
  expect(r.deny).toMatch(/could not run .*Run it yourself with Bash/s)
})

test(
  'annotate mode lets a stale claim through with a warning and runs nothing',
  { options: { mode: 'annotate' } },
  async ($, on) => {
    const w = world(on, { exitCode: 1 })
    await edit($)
    const r = await $.tool.call(CLAIM)
    expect(r.deny).toBeUndefined()
    expect(w.runs).toEqual([])
    expect(r.context?.at(-1)).toMatch(/no check ran since the last edit \(Edit src\/a.ts\)/)
  }
)

test('a "done" reply with no green check since the last edit is annotated', async ($, on) => {
  world(on, { exitCode: 0 })
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
  await bash($, CHECK)
  expect((await $.turn.complete(done)).text).toBe('Done, all tests pass.')
})
```

## Gaps against the spec

The prototype is the core mechanism. W1 owes the rest:

| Spec                 | Not in the prototype                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------------- |
| §5.1 rows 3, 4, 7, 8 | `mission_request_close` and `mission_verify_step` notes; the `SendMessage` receipt (W2); noun events (W3) |
| §6.2                 | Ignoring a check run with `backgroundTaskId`                                                              |
| §6.3                 | Seeding the ledger on resume and clear                                                                    |
| §7.2                 | `WORKTREE.local.md` and `.claude/worktree.md`; the resolver's exact parse rules                           |
| §8.1                 | The denylist, `CI=1`, no stdin, single-flight                                                             |
| §10, §11             | `HARNU_VERIFY_GATE`, staging, `api-surface.json`, CLI ceiling                                             |
| §9.3                 | Every Mission write (W3, through T447)                                                                    |
