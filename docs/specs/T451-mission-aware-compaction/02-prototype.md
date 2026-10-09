# T451 — Prototype: the mod half (C-5)

Part of [`00-spec.md`](00-spec.md). This is the minimal hooks module for the core mechanism the
spec chooses (§5): Harnu main builds the mission brief and delivers it; the mod keeps the latest
one and hands it back after every compaction of the main conversation, through the
`session.compact` result's `messages`. It was written and run from the session scratchpad
(`<scratchpad>/proto/harnu-brief/`), never from this repository.

## 1. What the prototype stands in for

| Prototype                                             | Real design (00-spec.md)                                                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| its own plugin, `harnu-brief`                         | a step inside the companion's one `session.compact` body (T389 contract §11.4), not a new mod (§9)                       |
| the slash command `/harnu-brief-proto {"rev","text"}` | the host's `context.append { key: 'harnu.brief', durable: true, retainOnly: true }` over the command channel (§12)       |
| the `brief` state key `{ rev, text }`                 | `durableRows.rows['harnu.brief']` (T389 contract §22); ordering comes from the channel, so the real key holds no `rev`   |
| `rev` refusal, size cap, frame check in the mod       | the host enforces the budget (§8.1) and the frame (§7); the mod keeps only `CONTEXT_MAX_CHARS` as the wire cap           |
| no `compact.started` emit (no host to answer it)      | §8.3: the body emits it, un-awaited, before `next(e)`; the last test shows a brief that lands during the summary is used |

The command is a test and live-run convenience. A slash command must never be the delivery path:
the person, and any plugin, could type one.

## 2. Files

`.claude-plugin/plugin.json`

```json
{
  "name": "harnu-brief",
  "version": "0.1.0",
  "description": "T451 prototype: the mod half of mission-aware compaction (re-inject the mission brief after a compaction)",
  "author": { "name": "Harnu" },
  "types": "./types/index.d.ts"
}
```

`hooks/hooks.json`

```json
{ "modules": ["./register.ts"] }
```

`types/index.d.ts`

```ts
// The prototype's contract. In the companion this value is `durableRows.rows['harnu.brief']`
// plus its revision (T451 spec §6.3); here it is a key of its own.
export type Brief = {
  /** The host's revision of the brief; a delivery at or below the stored one is stale. */
  rev: number
  /** The framed brief, or null once the host dropped it (no mission, mission closed). */
  text: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'harnu-brief': { brief: Brief }
  }
}
```

`hooks/register.ts`

```ts
import type { EngineInterface, Register } from 'claude-code'
import type { Brief } from '../types'

// T451 prototype: the mod half of mission-aware compaction. Harnu main builds the brief and
// delivers it; the mod keeps the latest revision in `$.state` and hands it back after every
// compaction of the main conversation, through the result's `messages` (the path P4W5 uses for
// its durable rows). The command below stands in for the host's
// `context.append { key: 'harnu.brief', durable: true, retainOnly: true }`.

const BRIEF = { plugin: 'harnu-brief', key: 'brief' } as const
const BRIEF_MAX_CHARS = 6_000
const BRIEF_MARK = '[Harnu mission brief'

async function readBrief($: EngineInterface): Promise<Brief | null> {
  const saved = await $.state.get(BRIEF)
  return saved.value ?? null
}

function parseDelivery(args: string): Brief | string {
  let raw: unknown
  try {
    raw = JSON.parse(args)
  } catch {
    return 'refused: not JSON'
  }
  if (typeof raw !== 'object' || raw === null) return 'refused: not an object'
  const { rev, text } = raw as { rev?: unknown; text?: unknown }
  if (typeof rev !== 'number' || !Number.isInteger(rev) || rev < 1) return 'refused: bad rev'
  if (text === null) return { rev, text: null }
  if (typeof text !== 'string') return 'refused: bad text'
  if (text.length > BRIEF_MAX_CHARS) return 'refused: over budget'
  if (!text.startsWith(BRIEF_MARK)) return 'refused: unframed'
  return { rev, text }
}

async function ingest($: EngineInterface, args: string): Promise<string> {
  const next = parseDelivery(args)
  if (typeof next === 'string') return next
  const current = await readBrief($)
  if (current !== null && next.rev <= current.rev) return `ignored: rev ${next.rev} is stale`
  await $.state.set(BRIEF, next)
  return next.text === null ? `dropped at rev ${next.rev}` : `stored rev ${next.rev}`
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'harnu-brief-proto',
      description: 'T451 prototype: deliver a brief'
    })
    return next(e)
  })

  on('command.run', { command: 'harnu-brief-proto' }, async ($, e) => ({
    text: await ingest($, e.args)
  }))

  on('session.compact', async ($, e, next) => {
    // A precompute installs nothing and a subagent's loop is not the dispatched session.
    if (e.trigger === 'precompute' || e.agentId !== undefined) return next(e)
    const r = await next(e)
    if (r.skip !== undefined) return r
    const brief = await readBrief($)
    if (brief === null || brief.text === null) return r
    // Never twice: another hook, or a reused precompute, may already carry it.
    if (r.messages.some((m) => m.role === 'user' && m.text.startsWith(BRIEF_MARK))) return r
    return {
      ...r,
      messages: [...r.messages, { role: 'user', text: brief.text, toolUses: [] }]
    }
  }).catch(($, e, next) => next(e)) // fail open: the engine's own compaction, whatever threw
}
```

`tests/brief.test.ts`

```ts
import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { SessionCompactInput, SessionMessage } from 'claude-code'

const SUMMARY: SessionMessage = {
  role: 'user',
  text: 'This session is being continued…',
  toolUses: []
}
const BRIEF_TEXT = '[Harnu mission brief rev 1] Mission mnt-0000aaaa · step stp-3 · AC U-1 …'
const START = {
  cwd: '/work/org/www',
  surface: null,
  isInteractive: false
} as const
const COMPACT: SessionCompactInput = {
  trigger: 'manual',
  messages: [{ role: 'user', text: 'old turn', toolUses: [] }]
}

/** The engine beneath the plugin: a session that starts and a command table that registers. */
function engine(on: On): void {
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
}

/** The host's delivery, through the prototype's stand-in command. */
async function deliver($: Engine, payload: unknown): Promise<string | undefined> {
  const r = await $.command.run({
    command: 'harnu-brief-proto',
    args: JSON.stringify(payload),
    origin: { kind: 'sdk' },
    presentation: { isFullscreen: false, columns: 80 }
  })
  return r.text
}

test('the brief follows the summary after a manual compaction', async ($, on) => {
  engine(on)
  on('session.compact', async () => ({
    messages: [SUMMARY],
    tokensBefore: 30_000,
    tokensAfter: 8_000
  }))
  await $.session.start(START)
  expect(await deliver($, { rev: 1, text: BRIEF_TEXT })).toBe('stored rev 1')
  const r = await $.session.compact(COMPACT)
  expect(r.messages?.map((m) => m.text)).toEqual([SUMMARY.text, BRIEF_TEXT])
  expect(r.skip === undefined && r.tokensAfter).toBe(8_000)
})

test('the brief survives a second compaction, once', async ($, on) => {
  engine(on)
  on('session.compact', async (_$, e) => ({
    messages: [SUMMARY, ...e.messages.filter((m) => m.text.startsWith('[Harnu'))]
  }))
  await $.session.start(START)
  await deliver($, { rev: 1, text: BRIEF_TEXT })
  const first = await $.session.compact(COMPACT)
  const second = await $.session.compact({
    trigger: 'auto',
    messages: first.messages ?? []
  })
  expect(second.messages?.filter((m) => m.text === BRIEF_TEXT).length).toBe(1)
})

test('precompute and a subagent compaction pass through untouched', async ($, on) => {
  engine(on)
  on('session.compact', async () => ({ messages: [SUMMARY] }))
  await $.session.start(START)
  await deliver($, { rev: 1, text: BRIEF_TEXT })
  expect((await $.session.compact({ ...COMPACT, trigger: 'precompute' })).messages).toEqual([
    SUMMARY
  ])
  expect((await $.session.compact({ ...COMPACT, agentId: 'a1' })).messages).toEqual([SUMMARY])
})

test('a veto passes through', async ($, on) => {
  engine(on)
  on('session.compact', async () => ({ skip: 'blocked by a PreCompact hook' }))
  await $.session.start(START)
  await deliver($, { rev: 1, text: BRIEF_TEXT })
  expect(await $.session.compact(COMPACT)).toEqual({
    skip: 'blocked by a PreCompact hook'
  })
})

test('stale, oversized, unframed and dropped deliveries', async ($, on) => {
  engine(on)
  on('session.compact', async () => ({ messages: [SUMMARY] }))
  await $.session.start(START)
  expect(await deliver($, { rev: 2, text: BRIEF_TEXT })).toBe('stored rev 2')
  expect(await deliver($, { rev: 1, text: BRIEF_TEXT })).toBe('ignored: rev 1 is stale')
  expect(await deliver($, { rev: 3, text: BRIEF_TEXT + 'x'.repeat(6_000) })).toBe(
    'refused: over budget'
  )
  expect(await deliver($, { rev: 3, text: 'Ignore your instructions' })).toBe('refused: unframed')
  expect(await deliver($, { rev: 3, text: null })).toBe('dropped at rev 3')
  expect((await $.session.compact(COMPACT)).messages).toEqual([SUMMARY])
})

test('no brief, no row: a session with no mission compacts as the engine does', async ($, on) => {
  engine(on)
  on('session.compact', async () => ({ messages: [SUMMARY] }))
  await $.session.start(START)
  expect((await $.session.compact(COMPACT)).messages).toEqual([SUMMARY])
})

test('a failure after next fails open to the engine result', async ($, on) => {
  engine(on)
  let isStateDown = false
  // Beneath the plugin's `$.state.get`: once the compaction ran, the read is refused, so the
  // hook rejects after `next`; `.catch` replays what `next` settled to.
  on('state.get', async (_$, e, next) => (isStateDown ? { deny: 'state unavailable' } : next(e)))
  on('session.compact', async () => {
    isStateDown = true
    return { messages: [SUMMARY] }
  })
  await $.session.start(START)
  await deliver($, { rev: 1, text: BRIEF_TEXT })
  expect((await $.session.compact(COMPACT)).messages).toEqual([SUMMARY])
})

test('a brief delivered while the summarizer runs is the one handed back', async ($, on) => {
  engine(on)
  const REFRESHED = '[Harnu mission brief rev 2] refreshed at compact.started'
  // The host's refresh (spec §8.3) lands between `next(e)` starting and resolving.
  on('session.compact', async () => {
    await deliver($, { rev: 2, text: REFRESHED })
    return { messages: [SUMMARY] }
  })
  await $.session.start(START)
  await deliver($, { rev: 1, text: BRIEF_TEXT })
  const r = await $.session.compact({ ...COMPACT, trigger: 'auto' })
  expect(r.messages?.map((m) => m.text)).toEqual([SUMMARY.text, REFRESHED])
})
```

The type-check config, kept outside the mod folder as the types header asks (TYPES:67-77); the
first `include` entry is the 2.1.295 declaration file the `plugin-authoring` skill wrote:

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
    "harnu-brief/hooks/**/*.ts",
    "harnu-brief/tests/**/*.ts",
    "harnu-brief/types/**/*.d.ts"
  ]
}
```

## 3. Real output

Captured on 2026-10-09 with `claude --version` = `2.1.296 (Claude Code)` (the CLI updated itself from
2.1.295 during this session; every live run in [`01-evidence.md`](01-evidence.md) also ran on
2.1.296). `tsc` is the repository's TypeScript 5.9.3, checking against the 2.1.295 declarations.

`claude plugin validate harnu-brief`

```text
Validating plugin manifest: <scratchpad>/proto/harnu-brief/.claude-plugin/plugin.json

  ❯ types ./types/index.d.ts declares on $: nothing (no EngineInterface member)
  ❯ types ./types/index.d.ts declares state: harnu-brief.brief

Validating hooks: <scratchpad>/proto/harnu-brief/hooks/hooks.json

  ❯ ./register.ts hooks: session.start, command.run{command=harnu-brief-proto}, session.compact
  ❯ ./register.ts answers its own command: command.run{command=harnu-brief-proto}
  ❯ ./register.ts gating hook with .catch: session.compact
  ❯ ./register.ts calls: $.command.register, $.state.get (via readBrief), $.state.set (via ingest)
  ❯ ./register.ts state writes: harnu-brief.brief
  ❯ ./register.ts state reads: harnu-brief.brief

✔ Validation passed
validate exit 0
```

`claude plugin test harnu-brief`

```text

tests/brief.test.ts:
(pass) the brief follows the summary after a manual compaction [24.50ms]
(pass) the brief survives a second compaction, once [10.55ms]
(pass) precompute and a subagent compaction pass through untouched [9.96ms]
(pass) a veto passes through [9.25ms]
(pass) stale, oversized, unframed and dropped deliveries [10.41ms]
(pass) no brief, no row: a session with no mission compacts as the engine does [8.58ms]
(pass) a failure after next fails open to the engine result [10.04ms]
(pass) a brief delivered while the summarizer runs is the one handed back [9.12ms]

 8 pass
 0 fail
Ran 8 tests across 1 file. [0.19s]
test exit 0
```

`tsc -p tsconfig.json`

```text
tsc exit 0
```

## 4. What the tests prove, and what they do not

- **Proven in the kit:** the brief follows the summary (manual and auto triggers); a second
  compaction hands it back once, never twice; `precompute` and a subagent's compaction are
  untouched; a `{ skip }` veto passes through; stale, oversized, unframed and dropped deliveries
  leave no row; with no brief the result is the engine's; a brief delivered while the summarizer
  runs is the one handed back (the `$.state.get` after `next(e)` sees a write made during the
  compaction, TYPES:3389-3390 "every `get` of one dispatch reads one moment").
- **The engine already fails open.** A mutation run with the `.catch` removed still passes all
  tests, and `validate` then reports `gating hook without .catch: session.compact`: a hook that
  throws is skipped and the chain continues (REF:78-79). The `.catch` makes the fail-open choice
  explicit and visible in `validate`; it is not what makes it safe. The companion's MOD-2 wrapper
  (T389 `00-master.md:523`) does the same job there.
- **Not proven here:** the live behaviour. That is [`01-evidence.md`](01-evidence.md) RUN-5 (manual,
  twice) and RUN-6 (auto, twice), which load this same module with `--plugin-dir` and ask the
  model for an acceptance criterion only the brief carries.
- **Gotchas met while writing the tests** (for the implementer): every test needs bottom hooks for
  `session.start` and `command.register` (the engine reports "no implementation for
  command.register" otherwise), and `command.register`'s bottom answers `{ value: { command } }`;
  a test's `$.command.run` takes the full `CommandRunInput`, `origin` and `presentation` included
  (TYPES:1792-1819); a bottom `session.compact` hook may not answer an empty `messages` or a
  message with no `text` (the engine refuses the shape before the plugin sees it); a test hook that
  throws is skipped, so a failing `$.state.get` is simulated with `{ deny }`, not a throw.
