# T455 — Prototype and engine runs (§10 of the spec, C-1, C-5)

Two artefacts, both run from the session scratchpad (never staged into Harnu):

- **`harnu-row-sensor`** — the core mechanism of the mod half, standalone: fold the rows
  `session.append` keeps into the compact row, coalesce, push; identity at start; a seed for loads
  (resume, fork); a fresh fold after `/clear`. In the real implementation the hooks become steps
  inside the Harnu mod's existing registrations (contract §11.4, MOD-4) and `post()` becomes the
  existing `emit()` (§5.3 of the spec). Here it POSTs to the URL in `HARNU_ROW_URL` so it runs alone.
  The prototype carries the fold's prompt, assistant and tool-call rules, the 500 ms trailing
  debounce, the turn-end flush, the seed and the `/clear` reset. W1 adds what the spec's wire shape
  has beyond it (§5.3–§5.4 of the spec): `title`, `userRows`, `lastRowAt`, `awaySummary`, the 2 s
  maximum wait, the re-send after hello and `resync`, and the hello fields.
- **`t455-probe`** — a logger that records what the design hinges on, run in real `claude -p`
  sessions (§P.4).

Engine: types written by Claude Code **2.1.295** (the `plugin-authoring` skill's
`types/claude-code.d.ts`); every run below on the installed CLI, **2.1.296**.

## P.1 `harnu-row-sensor`

### `.claude-plugin/plugin.json`

```json
{
  "name": "harnu-row-sensor",
  "version": "0.1.0",
  "description": "T455 prototype: pushes the sidebar's compact row from session.append.",
  "author": {
    "name": "Harnu"
  },
  "types": "./types/index.d.ts"
}
```

### `hooks/hooks.json`

```json
{ "modules": ["./register.ts"] }
```

### `types/index.d.ts`

```ts
declare module 'claude-code' {
  interface PluginState {
    'harnu-row-sensor': {
      /** The fold so far and the conversation it belongs to, read back after a reload. */
      row: {
        sid: string
        row: {
          firstPrompt: string | null
          lastPrompt: string | null
          lastAssistant: string | null
          toolCalls: number
          subagentToolCalls: number
          lastUuid: string | null
        }
      }
    }
  }
}
```

### `hooks/row.ts`

```ts
// The compact row: what the sidebar and the session preview read for a live session, folded
// from the rows the main conversation keeps. Pure: no `$`, so the host can run the same fold
// over a cold JSONL for the parity gate.

export const TEXT_MAX = 240

export interface Row {
  /** The first typed prompt of the conversation: the title fallback. Never changes once set. */
  firstPrompt: string | null
  lastPrompt: string | null
  lastAssistant: string | null
  /** `tool_use` blocks in the main loop's responses. */
  toolCalls: number
  /** `tool_use` blocks in subagents' responses, kept apart. */
  subagentToolCalls: number
  /** The id of the last row folded in: the host's parity probe reads the JSONL up to it. */
  lastUuid: string | null
}

export const emptyRow = (): Row => ({
  firstPrompt: null,
  lastPrompt: null,
  lastAssistant: null,
  toolCalls: 0,
  subagentToolCalls: 0,
  lastUuid: null
})

/** The shape both `session.append`'s message and an `ApiMessage` share. */
export interface Kept {
  role?: 'user' | 'assistant'
  isMeta?: true
  content: readonly { type: string; text?: string }[] | string
}

export function clip(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim()
  if (one.length <= TEXT_MAX) return one
  // never split a surrogate pair
  let end = TEXT_MAX - 1
  const c = one.charCodeAt(end - 1)
  if (c >= 0xd800 && c <= 0xdbff) end--
  return one.slice(0, end) + '…'
}

function textOf(m: Kept): string {
  if (typeof m.content === 'string') return m.content
  return m.content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join(' ')
}

function toolUses(m: Kept): number {
  if (typeof m.content === 'string') return 0
  return m.content.filter((b) => b.type === 'tool_use').length
}

/**
 * Folds one kept row in. `door` is `session.append`'s; a seed from `$.session.messages()`
 * passes `prompt` for a user row and `response` for an assistant row. Returns whether a field
 * the host shows changed.
 */
export function fold(
  row: Row,
  door: string,
  m: Kept,
  uuid: string | null,
  agentId: string | undefined
): boolean {
  if (uuid !== null) row.lastUuid = uuid
  if (agentId !== undefined) {
    if (door !== 'response') return false
    const n = toolUses(m)
    row.subagentToolCalls += n
    return n > 0
  }
  if (door === 'prompt' && m.role === 'user' && m.isMeta !== true) {
    const t = clip(textOf(m))
    if (t === '') return false
    if (row.firstPrompt === null) row.firstPrompt = t
    row.lastPrompt = t
    return true
  }
  if (door === 'response' && m.role === 'assistant') {
    let changed = false
    const n = toolUses(m)
    if (n > 0) {
      row.toolCalls += n
      changed = true
    }
    const t = clip(textOf(m))
    if (t !== '') {
      row.lastAssistant = t
      changed = true
    }
    return changed
  }
  return false
}
```

### `hooks/register.ts`

```ts
import type { EngineInterface, Register, Timer } from 'claude-code'
import { emptyRow, fold, type Row } from './row'

// T455 prototype: the `sense.row` family of the Harnu mod, standalone. In the companion the
// `post` below is the existing `emit()` into the events ring (P1W3); here it is one POST to the
// URL in HARNU_ROW_URL so the mechanism runs on its own.

type Dollar = EngineInterface

/** Coalescing window: a burst of rows (a response's blocks, a tool's result) is one push. */
export const ROW_DEBOUNCE_MS = 500
const ROW = { plugin: 'harnu-row-sensor', key: 'row' } as const

let row: Row = emptyRow()
let sid: string | null = null
let seq = 0
let dirty = false
let timer: Timer | null = null
/** `classic.SessionStart`'s `source`; it dispatches before `session.start` on a real CLI. */
let source: string | null = null

async function post($: Dollar, t: string, d: unknown): Promise<void> {
  const url = await $.env.get('HARNU_ROW_URL')
  if (typeof url !== 'string' || url === '') return // outside Harnu: nothing to tell
  if (sid === null) sid = await $.session.id() // after a /clear: the new conversation's id
  await $.http.fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sid, events: [{ seq: ++seq, t, ts: await $.clock.now(), d }] })
  })
}

async function flush($: Dollar): Promise<void> {
  timer?.cancel()
  timer = null
  if (!dirty) return
  dirty = false
  await $.state.set(ROW, { sid: sid ?? '', row }).catch(() => undefined)
  await post($, 'session.row', { ...row })
}

function markDirty($: Dollar): void {
  dirty = true
  if (timer !== null) return
  timer = $.clock.after(ROW_DEBOUNCE_MS, () => {
    timer = null
    void flush($).catch(() => undefined)
  })
}

/** Loads are not appends: a resumed conversation's rows are read once, here. */
async function seed($: Dollar): Promise<void> {
  const msgs = await $.session.messages({ as: 'api' })
  for (const m of msgs) {
    if (typeof m.content === 'string') continue // a string-content message has no blocks to fold
    fold(row, m.role === 'user' ? 'prompt' : 'response', m, null, undefined)
  }
}

export const register: Register = (on) => {
  row = emptyRow()
  sid = null
  dirty = false
  timer = null
  source = null

  on('classic.SessionStart', async ($, e, next) => {
    source = e.source
    sid = e.session_id // the payload is the source of truth for the id
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    sid ??= await $.session.id()
    const saved = await $.state.get(ROW)
    if (saved.value !== undefined && saved.value.sid === sid) {
      row = saved.value.row // a reload: the fold so far survives in the host's state
    } else if (source === 'resume' || source === 'fork') {
      await seed($) // only a load has rows no append will raise; a new session's are hook context
    }
    await post($, 'session.identity', { sid, source, cwd: e.cwd })
    dirty = true
    await flush($)
    return r
  }).catch(($, e, next) => next(e)) // fail open: the session starts whatever the sensor did

  on('session.append', async ($, e, next) => {
    const stored = await next(e) // the row as kept, after any plugin above rewrote it
    if (stored.deny === undefined && fold(row, e.door, stored.message, stored.uuid, e.agentId))
      markDirty($)
    return stored
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined) await flush($) // a turn boundary is never late
    return r
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      // the process goes on under a new id with no session.start: start a fresh fold
      row = emptyRow()
      sid = null
      dirty = false
      timer?.cancel()
      timer = null
    }
    return next(e)
  }).catch(($, e, next) => next(e))
}
```

### `tests/row.test.ts`

```ts
/* eslint-disable @typescript-eslint/no-explicit-any -- test code reads wire bodies loosely */
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const SID = '11111111-1111-4111-8111-111111111111'
const SID_2 = '22222222-2222-4222-8222-222222222222'
const URL_ = 'http://harnu.test/events'
const START = { cwd: '/w/repo', surface: 'terminal', isInteractive: true } as const

interface Wire {
  sid: string
  t: string
  d: any
}

/** The world beneath the mod: env, clock, the session's id and history, and a host that records. */
function world(on: On, opts: { env?: boolean; history?: any[]; saved?: unknown } = {}) {
  const clock = mock.clock(on, { now: 1_790_000_000_000 })
  mock.env(on, opts.env === false ? {} : { HARNU_ROW_URL: URL_ })
  mock.session(on) // the session.append bottom: stores what is raised
  const sid = { value: SID }
  const wire: Wire[] = []
  let historyReads = 0
  const state = new Map<string, unknown>(opts.saved !== undefined ? [['row', opts.saved]] : [])
  on('http.fetch', async (_$, e) => {
    const body = JSON.parse(e.init?.body ?? 'null')
    for (const ev of body.events) wire.push({ sid: body.sid, t: ev.t, d: ev.d })
    return { value: { status: 200, ok: true, headers: {}, text: '{"ok":true}' } }
  })
  on('state.get', async (_$, e) => ({
    value: { value: state.get(e.key), version: state.has(e.key) ? 1 : 0 }
  }))
  on('state.set', async (_$, e) => {
    state.set(e.key, e.value)
    return { value: { isSet: true, version: 1 } }
  })
  on('session.id', async () => ({ value: sid.value }))
  on('session.messages', async () => {
    historyReads++
    return { value: opts.history ?? [] }
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('turn.complete', async () => ({ text: '' }))
  on('session.end', async (_$, e) => ({ sessionId: e.sessionId }))
  on('classic.SessionStart', async () => ({}))
  return {
    clock,
    wire,
    sid,
    rows: () => wire.filter((w) => w.t === 'session.row'),
    reads: () => historyReads
  }
}

const prompt = (text: string, uuid: string, extra: Record<string, unknown> = {}) => ({
  message: { type: 'user', role: 'user', content: [{ type: 'text', text }], ...extra },
  door: 'prompt',
  origin: { kind: 'composer' },
  uuid
})
const response = (blocks: any[], uuid: string, agentId?: string) => ({
  message: { type: 'assistant', role: 'assistant', content: blocks },
  door: 'response',
  origin: { kind: 'model', model: 'claude-opus-5-5' },
  uuid,
  ...(agentId !== undefined ? { agentId } : {})
})
const toolUse = (id: string) => ({ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } })

test('a new session: identity, then one coalesced row per burst', async ($: any, on) => {
  const w = world(on)
  await $.session.start(START)
  await w.clock.settle()
  expect(w.wire.map((x) => x.t)).toEqual(['session.identity', 'session.row'])
  expect(w.wire[0]).toMatchObject({ sid: SID, d: { sid: SID, source: null, cwd: '/w/repo' } })
  expect(w.reads()).toBe(0) // a new session is never seeded

  await $.session.append(prompt('fix   the\nflaky test', 'u1'))
  await $.session.append(prompt('a reminder', 'u2', { isMeta: true }))
  await $.session.append(response([{ type: 'text', text: 'On it.' }, toolUse('t1')], 'u3'))
  await $.session.append(response([toolUse('t2')], 'u4', 'agent-1'))
  await w.clock.settle()
  expect(w.rows()).toHaveLength(1) // nothing before the window closes

  await w.clock.advance(500)
  expect(w.rows()).toHaveLength(2)
  expect(w.rows()[1]?.d).toEqual({
    firstPrompt: 'fix the flaky test',
    lastPrompt: 'fix the flaky test',
    lastAssistant: 'On it.',
    toolCalls: 1,
    subagentToolCalls: 1,
    lastUuid: 'u4'
  })
})

test('turn.complete flushes at once', async ($: any, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.session.append(prompt('hello', 'u1'))
  await $.turn.complete({
    answer: '',
    durationMs: 5,
    isAborted: false,
    turnId: 't',
    reason: 'answer'
  })
  await w.clock.settle()
  expect(w.rows().at(-1)?.d.lastPrompt).toBe('hello')
})

test('a resume seeds the row from the loaded conversation', async ($: any, on) => {
  const w = world(on, {
    history: [
      { role: 'user', content: [{ type: 'text', text: 'first ask' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'done' }, toolUse('t1')] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }
    ]
  })
  await $.classic.SessionStart({ source: 'resume', session_id: SID })
  await $.session.start(START)
  await w.clock.settle()
  expect(w.reads()).toBe(1)
  expect(w.wire[0]?.d).toMatchObject({ sid: SID, source: 'resume' })
  expect(w.rows()[0]?.d).toMatchObject({
    firstPrompt: 'first ask',
    lastAssistant: 'done',
    toolCalls: 1
  })
})

test('a fork reports its new id and source; lineage is the host spawn record', async ($: any, on) => {
  const w = world(on, {
    history: [{ role: 'user', content: [{ type: 'text', text: 'parent ask' }] }]
  })
  w.sid.value = 'stale-id' // `$.session.id()` is not read when the payload named one
  await $.classic.SessionStart({ source: 'fork', session_id: SID_2 })
  await $.session.start(START)
  await w.clock.settle()
  expect(w.wire[0]).toMatchObject({ sid: SID_2, d: { sid: SID_2, source: 'fork' } })
  expect(w.rows()[0]?.d.firstPrompt).toBe('parent ask')
})

test('a reload keeps the fold and does not read the history again', async ($: any, on) => {
  const saved = {
    sid: SID,
    row: {
      firstPrompt: 'a',
      lastPrompt: 'b',
      lastAssistant: 'c',
      toolCalls: 7,
      subagentToolCalls: 0,
      lastUuid: 'u9'
    }
  }
  const w = world(on, { saved })
  await $.session.start(START)
  await w.clock.settle()
  expect(w.reads()).toBe(0)
  expect(w.rows()[0]?.d.toolCalls).toBe(7)
})

test('outside Harnu nothing is sent', async ($: any, on) => {
  const w = world(on, { env: false })
  await $.session.start(START)
  await $.session.append(prompt('hello', 'u1'))
  await w.clock.advance(1_000)
  expect(w.wire).toEqual([])
})

test('a /clear starts a fresh fold under the new id', async ($: any, on) => {
  const w = world(on)
  await $.session.start(START)
  await $.session.append(prompt('before clear', 'u1'))
  await w.clock.advance(500)
  await $.session.end({ reason: 'clear', sessionId: SID, resume: { id: SID } })
  w.sid.value = SID_2
  await $.session.append(prompt('after clear', 'u2'))
  await w.clock.advance(500)
  const last = w.rows().at(-1)
  expect(last?.sid).toBe(SID_2)
  expect(last?.d).toMatchObject({ firstPrompt: 'after clear', toolCalls: 0 })
})
```

### `tsconfig.json` (kept outside the mod folder, as the types file's header says)

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
    "/tmp/claude-1000/bundled-skills/2.1.295/7677e87086511fae652e527dbd5b21fa/plugin-authoring/types/claude-code.d.ts",
    "harnu-row-sensor/hooks",
    "harnu-row-sensor/tests",
    "harnu-row-sensor/types"
  ]
}
```

## P.2 The checks, pasted as they printed

`claude plugin validate harnu-row-sensor` (Claude Code 2.1.296):

```text
Validating plugin manifest: <scratch>/proto/harnu-row-sensor/.claude-plugin/plugin.json

  ❯ types ./types/index.d.ts declares on $: nothing (no EngineInterface member)
  ❯ types ./types/index.d.ts declares state: harnu-row-sensor.row

Validating hooks: <scratch>/proto/harnu-row-sensor/hooks/hooks.json

  ❯ ./register.ts hooks: classic.SessionStart, session.start, session.append, turn.complete, session.end
  ❯ ./register.ts gating hook with .catch: classic.SessionStart
  ❯ ./register.ts gating hook with .catch: session.append
  ❯ ./register.ts calls: $.clock.after (via markDirty), $.clock.now (via post), $.env.get (via post), $.http.fetch (via post), $.session.id, $.session.messages (via seed), $.state.get, $.state.set (via flush)
  ❯ ./register.ts env writes: nothing
  ❯ ./register.ts env reads: HARNU_ROW_URL
  ❯ ./register.ts state writes: harnu-row-sensor.row
  ❯ ./register.ts state reads: harnu-row-sensor.row

✔ Validation passed
```

`claude plugin test harnu-row-sensor`:

```text
tests/row.test.ts:
(pass) a new session: identity, then one coalesced row per burst [31.53ms]
(pass) turn.complete flushes at once [15.50ms]
(pass) a resume seeds the row from the loaded conversation [12.86ms]
(pass) a fork reports its new id and source; lineage is the host spawn record [12.17ms]
(pass) a reload keeps the fold and does not read the history again [11.43ms]
(pass) outside Harnu nothing is sent [12.13ms]
(pass) a /clear starts a fresh fold under the new id [14.05ms]

 7 pass
 0 fail
Ran 7 tests across 1 file. [0.21s]
```

`tsc -p tsconfig.json` (TypeScript 5.9.3, the repo's): **exit 0**, no output.

**The tests catch regressions.** Two mutations, each run on a copy:

| Mutation                                                     | Result                                                              |
| ------------------------------------------------------------ | ------------------------------------------------------------------- |
| `row.ts`: subagent rows folded as main rows (`if (false) {`) | 6 pass, 1 fail: "a new session: identity, then one coalesced row …" |
| `register.ts`: seed on `resume` only, not on `fork`          | 6 pass, 1 fail: "a fork reports its new id and source; …"           |

The two gotchas the brief names were met on the way: `$.state` is reached through a const
reference (`{ plugin, key } as const`) — `claude plugin validate` refused a bare string key
("$.state.get takes a reference whose plugin and key are string literals") — and every `$` call a
test reaches is stubbed (`mock.clock`, `mock.env`, `mock.session`, and hooks for `http.fetch`,
`state.*`, `session.id`, `session.messages`), so no hook is skipped for a missing stub. No
`'x' in $` anywhere.

## P.3 The prototype in a real session

A local HTTP sink (`127.0.0.1:47455`, records every POST body) stood in for the host. The command:

```sh
env -u HARNU_SPAWN_TOKEN -u CLAUDE_CODE_PLUGIN_DIRS HARNU_ROW_URL=http://127.0.0.1:47455/events \
  claude -p "Use the Bash tool to run: echo one; then run: echo two; then reply with one short sentence saying you are finished." \
  --model haiku --allowedTools Bash --plugin-dir <scratch>/proto/harnu-row-sensor --debug-file <scratch>/proto-run.log
```

What the sink received (receive time in ms, sid prefix, event, payload):

```text
1791574766973 55e44e30 session.identity {"sid": "55e44e30-…", "source": "startup", "cwd": "<scratch>/work2"}
1791574766978 55e44e30 session.row {"firstPrompt": null, "lastPrompt": null, "lastAssistant": null, "toolCalls": 0, "subagentToolCalls": 0, "lastUuid": "7bd7936d-…"}
1791574769521 55e44e30 session.row {"firstPrompt": "Use the Bash tool to run: echo one; …", "lastPrompt": "Use the Bash tool to run: echo one; …", "lastAssistant": null, "toolCalls": 0, "subagentToolCalls": 0, "lastUuid": "904ef0d3-…"}
1791574770541 55e44e30 session.row {"firstPrompt": "…", "lastPrompt": "…", "lastAssistant": null, "toolCalls": 1, "subagentToolCalls": 0, "lastUuid": "2e4b7900-…"}
1791574775176 55e44e30 session.row {"firstPrompt": "…", "lastPrompt": "…", "lastAssistant": "Finished: both echo commands ran, printing \"one\" and \"two\".", "toolCalls": 1, "subagentToolCalls": 0, "lastUuid": "e1782097-…"}
```

The model ran both commands in one Bash call (`echo one; echo two`). **Parity by hand** against the
same session's JSONL: 1 `tool_use` block, the same last assistant text, and the CLI's own
`last-prompt` line holding the same prompt. 26 rows were appended; 4 POSTs carried them.

Hook cost, from the engine's debug log (`hooks module harnu-row-sensor@inline <event> settled in
<n>ms (worker hop, next() included)`):

| Event                  | Settle times                                                                    |
| ---------------------- | ------------------------------------------------------------------------------- |
| `session.append` (26×) | 0.3, 0.4 ×7, 0.5 ×2, 0.6 ×4, 0.7 ×2, 0.8, 0.9 ×3, 1.0 ×2, 1.1, 1.7, 1.8, 9.5 ms |
| `classic.SessionStart` | 58.9 ms                                                                         |
| `session.start`        | 20.8 ms                                                                         |
| `turn.complete`        | 3.8 ms                                                                          |
| `session.end`          | 1.3 ms                                                                          |

## P.4 What the engine does — `t455-probe` runs

The probe (source below) was loaded with `--plugin-dir` into four `claude -p --model haiku`
sessions in a scratch directory, with `HARNU_SPAWN_TOKEN` and `CLAUDE_CODE_PLUGIN_DIRS` removed
from the environment so the Harnu mod stayed out. Its source was formatted with the repo's
prettier after the runs (whitespace only); `claude plugin validate` passes on it as pasted.

| Run                                                                          | What it showed                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. new session, one Bash call                                                | `classic.SessionStart` (`source: "startup"`, `session_id`, exact `transcript_path`) fires **before** `session.start`; `$.session.id()` at `session.start` equals the transcript's file name. 26 `session.append` rows for one turn: 1 `prompt`, 3 `response` (one per block: `thinking`, `tool_use`, `text`), 1 `tool-result`, the rest `attachment` / `hook-context` / `notice`. |
| 1 (cont.) — uuids against the JSONL                                          | 25 of 26 appended uuids are rows of the JSONL, **in the same order**; the 26th, a `hook_success` attachment appended before `session.start`, is not in the file. `last-prompt`, `cost-state`, `atis-latch` and `queue-operation` lines are in the file and were never appended (they are not conversation rows).                                                                  |
| 2. `claude -p --resume <id>`                                                 | `source: "resume"`, **the same id**, appends go to the same file. `session.start` sees 4 loaded messages (`$.session.messages`), and **none of them is raised as `session.append`**: only the new prompt and response are.                                                                                                                                                        |
| 3. `claude -p --resume <id> --fork-session`                                  | `source: "fork"`, **a new id**, its own `<newid>.jsonl` in the same project dir. The engine names no parent anywhere: not on any event, and the fork's JSONL restamps all 45 lines with the new `sessionId` (no `forkedFrom` / `parentSessionId` key exists in it).                                                                                                               |
| 4. `claude -p --name "probe title alpha" --session-id <id>`, then `--resume` | `session_title: "probe title alpha"` on `classic.SessionStart` and on `classic.UserPromptSubmit`, in both runs; the JSONL holds the matching `custom-title` line. (`UserPromptSubmit.source` was absent under `-p`; the type says "may omit it while the field rolls out".)                                                                                                       |

Not run (assumptions the W0 spike checks, §11 of the spec): an interactive session; a mid-session
`/rename`; an `ai-title` reaching `session_title`; `/clear` in a live session (only the kit test
covers it); a subagent's rows (the kit test covers the `agentId` path only).

### `t455-probe/hooks/register.ts`

```ts
import type { EngineInterface, Register } from 'claude-code'

// Logs what a T455 design hinges on, one JSON file per process, written after every event.
const log: unknown[] = []
let out = ''

async function write($: EngineInterface): Promise<void> {
  if (out === '') {
    const dir = await $.env.get('T455_PROBE_DIR')
    if (typeof dir !== 'string') return
    out = `${dir}/probe-${await $.clock.now()}.json`
  }
  await $.fs.write(out, JSON.stringify(log, null, 1))
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    const msgs = await $.session.messages({ as: 'api' })
    log.push({
      ev: 'session.start',
      sid: await $.session.id(),
      cwd: e.cwd,
      isInteractive: e.isInteractive,
      loadedMessages: msgs.length
    })
    await write($)
    return r
  })
  on('classic.SessionStart', async ($, e, next) => {
    log.push({
      ev: 'classic.SessionStart',
      session_id: e.session_id,
      source: e.source,
      transcript_path: e.transcript_path,
      session_title: e.session_title ?? null
    })
    await write($)
    return next(e)
  })
  on('classic.UserPromptSubmit', async ($, e, next) => {
    log.push({
      ev: 'classic.UserPromptSubmit',
      session_title: e.session_title ?? null,
      source: e.source ?? null
    })
    await write($)
    return next(e)
  })
  on('session.append', async ($, e, next) => {
    const r = await next(e)
    const blocks = Array.isArray(r.message.content) ? r.message.content.map((b) => b.type) : []
    log.push({
      ev: 'session.append',
      door: e.door,
      type: r.message.type,
      role: r.message.role,
      isMeta: r.message.isMeta,
      name: r.message.name,
      uuid: r.deny === undefined ? r.uuid : null,
      blocks,
      agentId: e.agentId,
      sidNow: await $.session.id()
    })
    await write($)
    return r
  })
  on('turn.complete', async ($, e, next) => {
    log.push({ ev: 'turn.complete', reason: e.reason, agentId: e.agentId })
    await write($)
    return next(e)
  })
  on('session.end', async ($, e, next) => {
    log.push({ ev: 'session.end', reason: e.reason, sessionId: e.sessionId })
    await write($)
    return next(e)
  })
}
```
