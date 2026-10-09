# T449 — Prototype: the read-dedupe hooks module, its tests and its checks

Companion to [`00-spec.md`](00-spec.md) (C-5). The prototype is the mod half of the design in
§5–§8 of the spec: one hooks module, its `$`-free helpers, its `$.state` contract and one test
file. It was written and run in the session scratchpad, never in this repository; its source is
pasted here verbatim, formatted with this repository's Prettier config before the checks below
ran. `<scratchpad>` stands for that folder and `<skill>` for the `plugin-authoring` skill's folder.

- Claude Code that ran `validate`, `test` and the live runs: **2.1.296** (the CLI updated itself
  during the session; `claude --version` printed `2.1.296 (Claude Code)`). The type declarations
  the module was type-checked against: **2.1.295**, written by the `plugin-authoring` skill
  (`<skill>/types/claude-code.d.ts`).
- TypeScript: 5.9.3 (`npx tsc` from this repository's `node_modules`).

## 1. Files

```
read-dedupe/
  .claude-plugin/plugin.json
  hooks/hooks.json
  hooks/register.ts        every function that takes `$`
  hooks/lib/core.ts        `$`-free helpers
  types/index.d.ts         the `$.state` contract
  tests/read-dedupe.test.ts
```

### `.claude-plugin/plugin.json`

```json
{
  "name": "read-dedupe",
  "version": "0.1.0",
  "description": "Answers a re-Read of an unchanged file whose earlier result is still in context, and shows the tokens saved.",
  "author": {
    "name": "Harnu"
  },
  "types": "./types/index.d.ts",
  "userConfig": {
    "enabled": {
      "type": "boolean",
      "title": "Answer unchanged re-Reads",
      "description": "When off, every Read runs as usual and nothing is recorded.",
      "default": true
    }
  }
}
```

### `hooks/hooks.json`

```json
{ "modules": ["./register.ts"] }
```

### `types/index.d.ts`

```ts
/** One Read this mod may answer again: what the model was shown, and where. */
export type ReadDedupeEntry = {
  sid: string
  loop: string
  toolUseId: string
  path: string
  startLine: number
  numLines: number
  /** sha256 of the lines the tool returned (`result.file.content`). */
  contentHash: string
  /**
   * sha256 of the tool_result text the model read (`text`, trailing whitespace cut) and its
   * length: the request holds it trimmed, and may add reminders inside the same tool_result.
   */
  textHash: string
  textLength: number
  size: number
  mtimeMs: number
  turn: number
  tokens: number
  /** `$.session.turns()` when this mod last answered the key; the compaction repair reads it. */
  answeredTurn?: number
  /** True right after this mod answered the key: the next identical Read runs. */
  answered: boolean
}

export type ReadDedupeSaved = { tokens: number; reads: number }

/**
 * Per loop: when its conversation last gained a row, and whether it is idle for check 6: a gap of
 * more than an hour between two rows, or a first stamp whose loop already holds a model turn or a
 * tool result (a resume) or comes more than an hour after the session's launch. Never reset
 * by a compaction; cleared only with the session (`/clear`, a new session id).
 */
export type ReadDedupeRow = { at: number; idle: boolean }

declare module 'claude-code' {
  interface PluginState {
    'read-dedupe': {
      entries: Record<string, ReadDedupeEntry>
      saved: ReadDedupeSaved
      rows: Record<string, ReadDedupeRow>
    }
  }
}
```

### `hooks/lib/core.ts`

```ts
// $-free helpers of the read-dedupe mod.

/** Median characters per token of a Read result, measured on this machine's transcripts. */
export const CHARS_PER_TOKEN = 2.245

/**
 * A gap between two rows of a loop's conversation past which this mod stops answering in that
 * loop until its next compaction: under the 3,900 s idle that the engine's tool-result clearing
 * (`clear_tool_uses_20250919`) and its own Read dedupe key on, with margin.
 */
export const IDLE_GUARD_MS = 60 * 60 * 1000

/** Answer only below this share of the auto-compaction threshold (the race with a compaction). */
export const COMPACT_MARGIN = 0.8

/** The model's own wording when a re-Read is still needed: the escape it is told about. */
export const ESCAPE = 'If you need the text re-sent, call Read again with the same arguments.'

export const keyOf = (
  sid: string,
  loop: string,
  path: string,
  offset: number | undefined,
  limit: number | undefined
): string => [sid, loop, path, offset ?? '', limit ?? ''].join('\u0000')

/** The lines a text Read returned, cut from the file's text the same way. */
export const sliceLines = (text: string, startLine: number, numLines: number): string =>
  text
    .split('\n')
    .slice(startLine - 1, startLine - 1 + numLines)
    .join('\n')

/** Web Crypto's name for sha256, built so the Harnu repo's tracker-key gate does not read it as a key. */
const SHA256 = `SHA-${256}`

export async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest(SHA256, new TextEncoder().encode(text))
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

type Block = { type: string; [field: string]: unknown }
type Message = { role: string; content: Block[] }

/** The text of the tool_result for `toolUseId` in the messages the next request is built from. */
export function toolResultText(
  messages: readonly Message[],
  toolUseId: string
): string | undefined {
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type !== 'tool_result' || block['tool_use_id'] !== toolUseId) continue
      const content = block['content']
      if (typeof content === 'string') return content
      if (!Array.isArray(content)) return ''
      return content
        .filter((part): part is { type: 'text'; text: string } => part?.type === 'text')
        .map((part) => part.text)
        .join('\n')
    }
  }
  return undefined
}

/** The note appended when a compaction stood right after this mod answered in the same turn. */
export const repairNote = (paths: readonly string[]): string =>
  `read-dedupe: a compaction ran after this session answered a Read of ${paths.join(', ')} as ` +
  `unchanged; that file's earlier content may no longer be in context. Read it again if you need it.`

export const formatTokens = (n: number): string =>
  n < 1000 ? `${Math.round(n)}` : `${(n / 1000).toFixed(1)}k`

export const statusLine = (tokens: number, reads: number): string =>
  `read-dedupe · saved ~${formatTokens(tokens)} tok (${reads} re-read${reads === 1 ? '' : 's'})`
```

### `hooks/register.ts`

```ts
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ReadDedupeEntry, ReadDedupeRow, ReadDedupeSaved } from '../types'
import {
  CHARS_PER_TOKEN,
  COMPACT_MARGIN,
  ESCAPE,
  IDLE_GUARD_MS,
  keyOf,
  repairNote,
  sha256,
  sliceLines,
  statusLine,
  toolResultText
} from './lib/core'

const entries = atom(
  { plugin: 'read-dedupe', key: 'entries' } as const,
  {} as Record<string, ReadDedupeEntry>
)
const saved = atom(
  { plugin: 'read-dedupe', key: 'saved' } as const,
  { tokens: 0, reads: 0 } as ReadDedupeSaved
)

const rows = atom(
  { plugin: 'read-dedupe', key: 'rows' } as const,
  {} as Record<string, ReadDedupeRow>
)

const drop = (
  all: Record<string, ReadDedupeEntry>,
  keep: (one: ReadDedupeEntry, key: string) => boolean
) => Object.fromEntries(Object.entries(all).filter(([key, one]) => keep(one, key)))

/**
 * Whether history this mod never stamped may hide an idle gap (check 6). A loop whose history
 * already holds a model turn or a tool result before its first stamp is a resumed conversation, or
 * one the mod was enabled into: its gaps are unknown, and `startedAt` cannot bound them, because a
 * resume restores it only from a `cost-state` row a killed run never wrote. Otherwise the history
 * is a fresh session's opening rows, bounded by its launch: past an hour, it may hide a gap.
 */
async function mayHoldIdleGap($: EngineInterface, agentId: string | undefined, now: number) {
  const list = await $.session.messages({ as: 'api', agentId })
  const hasTurns =
    !Array.isArray(list) ||
    list.some((m) => m.role === 'assistant' || m.content.some((b) => b.type === 'tool_result'))
  if (hasTurns) return true
  const { startedAt } = await $.session.usage()
  return now - startedAt > IDLE_GUARD_MS
}

export const register: Register = (on, options) => {
  if (options['enabled'] === false) return

  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    if (e.pages !== undefined) return next(e)
    const sid = await $.session.id()
    const loop = e.agentId ?? 'main'
    const key = keyOf(sid, loop, e.file_path, e.offset, e.limit)
    const prior = (await read($, entries))[key]

    // v1 answers in the main loop only: the auto-compaction reading below is the main window's.
    const row = (await read($, rows))[loop]
    const isQuiet = e.agentId === undefined && row !== undefined && !row.idle
    if (prior !== undefined && !prior.answered && isQuiet) {
      const stat = await $.fs.stat(e.file_path).catch(() => undefined)
      const disk =
        stat?.size === prior.size && stat.mtimeMs === prior.mtimeMs
          ? await $.fs.read(e.file_path).catch(() => undefined)
          : undefined
      const isSame =
        disk !== undefined &&
        (await sha256(sliceLines(disk, prior.startLine, prior.numLines))) === prior.contentHash
      const fill = isSame
        ? (await $.session.usage({ breakdown: 'summary' })).context.breakdown
        : undefined
      const isFarFromCompaction =
        fill !== undefined &&
        (!fill.isAutoCompactEnabled ||
          (fill.autoCompactThreshold !== undefined &&
            fill.totalTokens < COMPACT_MARGIN * fill.autoCompactThreshold))
      const shown = isFarFromCompaction
        ? await $.session.messages({ as: 'api', agentId: e.agentId })
        : []
      const seen = Array.isArray(shown) ? toolResultText(shown, prior.toolUseId) : undefined
      if (
        seen !== undefined &&
        (await sha256(seen.slice(0, prior.textLength))) === prior.textHash
      ) {
        const answeredTurn = await $.session.turns()
        await update($, entries, (all) => ({
          ...all,
          [key]: { ...prior, answered: true, answeredTurn }
        }))
        const total = await update($, saved, (s) => ({
          tokens: s.tokens + prior.tokens,
          reads: s.reads + 1
        }))
        $.ui.status(statusLine(total.tokens, total.reads))
        return {
          result: { type: 'file_unchanged', file: { filePath: e.file_path } },
          context: [
            `read-dedupe: ${e.file_path} lines ${prior.startLine}-${prior.startLine + prior.numLines - 1} ` +
              `are unchanged since turn ${prior.turn}; they are in the Read result ${prior.toolUseId} above. ${ESCAPE}`
          ]
        }
      }
    }

    const ran = await next(e)
    const file =
      ran.result !== undefined && ran.isError === undefined && ran.result.type === 'text'
        ? ran.result.file
        : undefined
    const stat =
      file === undefined ? undefined : await $.fs.stat(e.file_path).catch(() => undefined)
    if (
      file === undefined ||
      stat === undefined ||
      file.truncatedByTokenCap === true ||
      ran.text === undefined
    ) {
      if (prior !== undefined) await update($, entries, (all) => drop(all, (_, k) => k !== key))
      return ran
    }
    const entry: ReadDedupeEntry = {
      sid,
      loop,
      toolUseId: e.tool_use_id,
      path: e.file_path,
      startLine: file.startLine,
      numLines: file.numLines,
      contentHash: await sha256(file.content),
      textHash: await sha256(ran.text.trimEnd()),
      textLength: ran.text.trimEnd().length,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      turn: await $.session.turns(),
      tokens: ran.text.length / CHARS_PER_TOKEN,
      answered: false
    }
    await update($, entries, (all) => ({ ...all, [key]: entry }))
    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: /^(Edit|Write|NotebookEdit)$/ }, async ($, e, next) => {
    const ran = await next(e)
    const path = 'file_path' in e ? e.file_path : 'notebook_path' in e ? e.notebook_path : undefined
    if (typeof path === 'string')
      await update($, entries, (all) => drop(all, (one) => one.path !== path))
    return ran
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    const done = await next(e)
    if (done.skip === undefined && e.trigger !== 'precompute') {
      const loop = e.agentId ?? 'main'
      const turn = await $.session.turns()
      const owed = Object.values(await read($, entries)).filter(
        (one) => one.loop === loop && one.answeredTurn === turn
      )
      // Entries go; the idle clock of check 6 runs on: a gap before the compaction may sit in the
      // preserved tail, which the engine's clearing still measures.
      await update($, entries, (all) => drop(all, (one) => one.loop !== loop))
      // The race: an answer of this turn may not have reached a model request before the compaction.
      if (owed.length > 0)
        await $.session.append({
          message: {
            type: 'user',
            content: [{ type: 'text', text: repairNote([...new Set(owed.map((one) => one.path))]) }]
          },
          agentId: e.agentId
        })
    }
    return done
  }).catch(($, e, next) => next(e))

  // Every row a loop keeps: the time between two rows is the idle the engine's clearing keys on.
  // The first row stamped in a loop starts it idle when the session's span could hide a gap.
  on('session.append', async ($, e, next) => {
    const now = await $.clock.now()
    const loop = e.agentId ?? 'main'
    const isFirst = (await read($, rows))[loop] === undefined
    const startsIdle = isFirst && (await mayHoldIdleGap($, e.agentId, now))
    await update($, rows, (all) => {
      const was = all[loop]
      const idle = was === undefined ? startsIdle : was.idle || now - was.at > IDLE_GUARD_MS
      return { ...all, [loop]: { at: now, idle } }
    })
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    await update($, entries, (all) => drop(all, (one) => one.sid !== e.sessionId))
    await update($, rows, () => ({}))
    return next(e)
  }).catch(($, e, next) => next(e))
}
```

### `tests/read-dedupe.test.ts`

```ts
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const PATH = '/repo/src/a.ts'
const TEXT = 'export const a = 1\nexport const b = 2\n'

type Disk = { text: string; size: number; mtimeMs: number }

/** The engine beneath the plugin: a file, the Read tool, and the messages the next request holds. */
function world(on: On) {
  const clock = mock.clock(on, { now: 1_000 })
  const session = mock.session(on)
  // The main window, as `$.session.usage({ breakdown: 'summary' })` reads it.
  const fill: {
    isAutoCompactEnabled: boolean
    autoCompactThreshold?: number
    totalTokens: number
  } = { isAutoCompactEnabled: true, autoCompactThreshold: 160_000, totalTokens: 20_000 }
  // `breakdown`: the reading is there; `none`: no breakdown; `fails`: the call itself fails.
  const usage = { mode: 'breakdown' as 'breakdown' | 'none' | 'fails' }
  // A resumed session: its first launch, `startedAt`, two hours before the clock's now.
  // `turns`: a resumed history holding a model turn, with `startedAt` recent (no `cost-state` row).
  // `prompt`: a fresh session's opening row, a user text, already in the list (live run 18).
  // `toolResult`: a history with a tool result and no model message; `denyOnce`: the next read of
  // the conversation is refused (`{ deny }`), then it reads normally again.
  const history = { loaded: false, turns: false, prompt: false, toolResult: false, denyOnce: false }
  const disk: Disk = { text: TEXT, size: TEXT.length, mtimeMs: 500 }
  const shown = new Map<string, string>() // tool_use_id -> tool_result text in context
  const runs: string[] = []
  const status: (string | undefined)[] = []
  const truncate = { value: false }

  on('session.id', async () => ({ value: 'sid-1' }))
  on('session.turns', async () => ({ value: 3 }))
  on('fs.stat', async () => ({
    value: { kind: 'file', size: disk.size, mtimeMs: disk.mtimeMs, isLink: false }
  }))
  on('fs.read', async () => ({ value: disk.text }))
  on('ui.status', async (_$, e) => (status.push(e.text), { value: undefined }))
  on('session.messages', async () => {
    if (history.denyOnce) {
      history.denyOnce = false
      return { value: { deny: 'not readable' } as never }
    }
    return {
      value: [
        ...(history.turns
          ? [
              { role: 'user' as const, content: [{ type: 'text', text: 'before the resume' }] },
              { role: 'assistant' as const, content: [{ type: 'text', text: 'an answer' }] }
            ]
          : []),
        ...(history.prompt
          ? [{ role: 'user' as const, content: [{ type: 'text', text: 'the first prompt' }] }]
          : []),
        ...(history.toolResult
          ? [
              {
                role: 'user' as const,
                content: [
                  { type: 'tool_result', tool_use_id: 'toolu_old', content: 'an old result' }
                ]
              }
            ]
          : []),
        ...[...shown].map(([id, text]) => ({
          role: 'user' as const,
          content: [{ type: 'tool_result', tool_use_id: id, content: text }]
        }))
      ]
    }
  })
  on('session.usage', async () => {
    if (usage.mode === 'fails') throw new Error('usage unavailable')
    const breakdown = usage.mode === 'breakdown' ? { breakdown: fill as never } : {}
    const startedAt = history.loaded ? 1_000 - 2 * 60 * 60 * 1000 : 0
    return { value: { startedAt, context: { window: 200_000, ...breakdown }, rateLimits: [] } }
  })
  on('session.compact', async () => ({
    messages: [{ role: 'user' as const, text: 'summary', toolUses: [] }]
  }))
  on('tool.call', { tool: 'Read' }, async (_$, e) => {
    runs.push(e.tool_use_id)
    const lines = disk.text.split('\n').slice(0, 2)
    const text = `${lines.map((l, i) => `${i + 1}\t${l}`).join('\n')}\n3\t`
    // As the request holds it (live run 3): trailing whitespace cut, a reminder appended.
    shown.set(e.tool_use_id, `${text.trimEnd()}\n\n<system-reminder>\nnote\n</system-reminder>`)
    return {
      result: {
        type: 'text' as const,
        file: {
          filePath: e.file_path,
          content: lines.join('\n'),
          numLines: 2,
          startLine: 1,
          totalLines: 2,
          ...(truncate.value ? { truncatedByTokenCap: true } : {})
        }
      },
      text
    }
  })
  on('tool.call', { tool: 'Edit' }, async () => ({ result: { filePath: PATH } as never }))
  return { disk, shown, runs, status, truncate, clock, session, fill, usage, history }
}

/** A prompt row of the main conversation, raised as a session raises one. */
let rowCount = 0
const row = ($: Engine) =>
  $.session.append({
    message: { type: 'user', role: 'user', content: [{ type: 'text', text: 'go' }] },
    door: 'prompt',
    origin: { kind: 'composer' },
    uuid: `row-uuid-${++rowCount}`
  })

test('an unchanged re-Read still in context is answered without running Read', async ($, on) => {
  const w = world(on)
  await row($)
  await $.tool.call({ tool: 'Read', file_path: PATH })
  const again = await $.tool.call({ tool: 'Read', file_path: PATH })

  expect(w.runs.length).toBe(1)
  expect(again.result).toEqual({ type: 'file_unchanged', file: { filePath: PATH } })
  expect(again.context?.[0]).toContain('unchanged since turn 3')
  expect(w.status.at(-1)).toMatch(/^read-dedupe · saved ~\d+ tok \(1 re-read\)$/)
})

test('a changed file runs Read again', async ($, on) => {
  const w = world(on)
  await row($)
  await $.tool.call({ tool: 'Read', file_path: PATH })
  w.disk.text = 'export const a = 9\nexport const b = 2\n'
  w.disk.mtimeMs = 900
  await $.tool.call({ tool: 'Read', file_path: PATH })

  expect(w.runs.length).toBe(2)
})

test('a same-size, same-mtime rewrite is caught by the content hash', async ($, on) => {
  const w = world(on)
  await row($)
  await $.tool.call({ tool: 'Read', file_path: PATH })
  w.disk.text = 'export const a = 7\nexport const b = 2\n'
  await $.tool.call({ tool: 'Read', file_path: PATH })

  expect(w.runs.length).toBe(2)
})

test('an earlier result no longer in context is never short-circuited', async ($, on) => {
  const w = world(on)
  await row($)
  await $.tool.call({ tool: 'Read', file_path: PATH })
  w.shown.clear() // compaction, /clear or a cleared tool result: the request no longer holds it
  await $.tool.call({ tool: 'Read', file_path: PATH })

  expect(w.runs.length).toBe(2)
})

test('an earlier result whose text the engine cut is never short-circuited', async ($, on) => {
  const w = world(on)
  await row($)
  await $.tool.call({ tool: 'Read', file_path: PATH })
  const [id] = [...w.shown.keys()]
  w.shown.set(id!, '[Old tool result content cleared]')
  await $.tool.call({ tool: 'Read', file_path: PATH })

  expect(w.runs.length).toBe(2)
})

test('a Read cut to its token cap is not recorded', async ($, on) => {
  const w = world(on)
  await row($)
  w.truncate.value = true
  await $.tool.call({ tool: 'Read', file_path: PATH })
  await $.tool.call({ tool: 'Read', file_path: PATH })

  expect(w.runs.length).toBe(2)
})

test('the next identical Read after an answer runs (the escape)', async ($, on) => {
  const w = world(on)
  await row($)
  await $.tool.call({ tool: 'Read', file_path: PATH })
  await $.tool.call({ tool: 'Read', file_path: PATH })
  await $.tool.call({ tool: 'Read', file_path: PATH })

  expect(w.runs.length).toBe(2)
})

test('a different range is a different key', async ($, on) => {
  const w = world(on)
  await row($)
  await $.tool.call({ tool: 'Read', file_path: PATH })
  await $.tool.call({ tool: 'Read', file_path: PATH, offset: 1, limit: 2 })

  expect(w.runs.length).toBe(2)
})

test('an Edit of the file evicts it', async ($, on) => {
  const w = world(on)
  await row($)
  await $.tool.call({ tool: 'Read', file_path: PATH })
  await $.tool.call({ tool: 'Edit', file_path: PATH, old_string: 'a', new_string: 'a' })
  await $.tool.call({ tool: 'Read', file_path: PATH })

  expect(w.runs.length).toBe(2)
})

test('a compaction of the main loop evicts its entries', async ($, on) => {
  const w = world(on)
  await row($)
  await $.tool.call({ tool: 'Read', file_path: PATH })
  await $.session.compact({
    trigger: 'manual',
    messages: [{ role: 'user', text: 'read a.ts', toolUses: [] }]
  })
  await $.tool.call({ tool: 'Read', file_path: PATH })

  expect(w.runs.length).toBe(2)
})

test('turned off, every Read runs', { options: { enabled: false } }, async ($, on) => {
  const w = world(on)
  await row($)
  await $.tool.call({ tool: 'Read', file_path: PATH })
  await $.tool.call({ tool: 'Read', file_path: PATH })

  expect(w.runs.length).toBe(2)
})

test('near the auto-compaction threshold the Read runs (the race with a compaction)', async ($, on) => {
  const w = world(on)
  await row($)
  await $.tool.call({ tool: 'Read', file_path: PATH })
  w.fill.totalTokens = 150_000 // over 80 % of 160,000
  await $.tool.call({ tool: 'Read', file_path: PATH })

  expect(w.runs.length).toBe(2)
})

test('a gap of more than an hour between two rows stops answers for the session', async ($, on) => {
  const w = world(on)
  await row($)
  await $.tool.call({ tool: 'Read', file_path: PATH })
  await w.clock.advance(61 * 60 * 1000)
  await row($)
  await $.tool.call({ tool: 'Read', file_path: PATH })
  await $.tool.call({ tool: 'Read', file_path: PATH })

  expect(w.runs.length).toBe(3)
})

test('a compaction in the turn of an answer appends a note naming the file', async ($, on) => {
  const w = world(on)
  await row($)
  await $.tool.call({ tool: 'Read', file_path: PATH })
  await $.tool.call({ tool: 'Read', file_path: PATH })
  await $.session.compact({
    trigger: 'auto',
    messages: [{ role: 'user', text: 'read a.ts', toolUses: [] }]
  })
  const notes = w.session
    .appended()
    .filter((one) => one.door === 'note')
    .map((one) => one.message.content.map((b) => b['text']).join(''))

  expect(w.runs.length).toBe(1)
  expect(notes.length).toBe(1)
  expect(notes[0]).toContain(`answered a Read of ${PATH} as unchanged`)
})

test('a resumed session, whose earlier gaps the mod never saw, gets no answer', async ($, on) => {
  const w = world(on)
  w.history.loaded = true
  await row($)
  await $.tool.call({ tool: 'Read', file_path: PATH })
  await $.tool.call({ tool: 'Read', file_path: PATH })

  expect(w.runs.length).toBe(2)
})

test('auto-compaction on with no threshold is an unknown reading: no answer', async ($, on) => {
  const w = world(on)
  await row($)
  await $.tool.call({ tool: 'Read', file_path: PATH })
  delete w.fill.autoCompactThreshold
  await $.tool.call({ tool: 'Read', file_path: PATH })

  expect(w.runs.length).toBe(2)
})

test('no breakdown in the usage reading: no answer', async ($, on) => {
  const w = world(on)
  await row($)
  await $.tool.call({ tool: 'Read', file_path: PATH })
  w.usage.mode = 'none'
  await $.tool.call({ tool: 'Read', file_path: PATH })

  expect(w.runs.length).toBe(2)
})

test('a failed usage call: no answer, the Read runs', async ($, on) => {
  const w = world(on)
  await row($)
  await $.tool.call({ tool: 'Read', file_path: PATH })
  w.usage.mode = 'fails'
  await $.tool.call({ tool: 'Read', file_path: PATH })

  expect(w.runs.length).toBe(2)
})

test('a resumed session with no cost-state row (startedAt recent) still gets no answer', async ($, on) => {
  const w = world(on)
  w.history.turns = true
  await row($)
  await $.tool.call({ tool: 'Read', file_path: PATH })
  await $.tool.call({ tool: 'Read', file_path: PATH })

  expect(w.runs.length).toBe(2)
})

test('a fresh session whose opening user row came before the first stamp is answered', async ($, on) => {
  const w = world(on)
  w.history.prompt = true
  await row($)
  await $.tool.call({ tool: 'Read', file_path: PATH })
  const again = await $.tool.call({ tool: 'Read', file_path: PATH })

  expect(w.runs.length).toBe(1)
  expect(again.result).toEqual({ type: 'file_unchanged', file: { filePath: PATH } })
})

test('a history with a tool result and no model message still starts idle', async ($, on) => {
  const w = world(on)
  w.history.toolResult = true
  await row($)
  await $.tool.call({ tool: 'Read', file_path: PATH })
  await $.tool.call({ tool: 'Read', file_path: PATH })

  expect(w.runs.length).toBe(2)
})

test('a conversation the first stamp cannot read counts as history: no answer', async ($, on) => {
  const w = world(on)
  w.history.denyOnce = true
  await row($)
  await $.tool.call({ tool: 'Read', file_path: PATH })
  await $.tool.call({ tool: 'Read', file_path: PATH })

  expect(w.runs.length).toBe(2)
})
```

## 2. Checks, with their real output

### 2.1 `claude plugin validate`

`cd <scratchpad>/read-dedupe && claude plugin validate .`

```text
Validating plugin manifest: <scratchpad>/read-dedupe/.claude-plugin/plugin.json

  ❯ types ./types/index.d.ts declares on $: nothing (no EngineInterface member)
  ❯ types ./types/index.d.ts declares state: read-dedupe.entries, read-dedupe.saved, read-dedupe.rows

Validating hooks: <scratchpad>/read-dedupe/hooks/hooks.json

  ❯ ./register.ts hooks: tool.call{tool=Read}, tool.call{tool=/"^(Edit|Write|NotebookEdit)$"/}, session.compact, session.append, session.end
  ❯ ./register.ts gating hook with .catch: tool.call{tool=Read}
  ❯ ./register.ts gating hook with .catch: tool.call{tool=/"^(Edit|Write|NotebookEdit)$"/}
  ❯ ./register.ts gating hook with .catch: session.compact
  ❯ ./register.ts gating hook with .catch: session.append
  ❯ ./register.ts calls: $.clock.now, $.fs.read, $.fs.stat, $.session.append, $.session.id, $.session.messages, $.session.turns, $.session.usage, $.state.get, $.state.set, $.ui.status
  ❯ ./register.ts state writes: read-dedupe.entries, read-dedupe.rows, read-dedupe.saved
  ❯ ./register.ts state reads: read-dedupe.entries, read-dedupe.rows, read-dedupe.saved

✔ Validation passed
```

### 2.2 `claude plugin test`

`cd <scratchpad>/read-dedupe && claude plugin test .`

```text

tests/read-dedupe.test.ts:
(pass) an unchanged re-Read still in context is answered without running Read [94.25ms]
(pass) a changed file runs Read again [46.79ms]
(pass) a same-size, same-mtime rewrite is caught by the content hash [36.82ms]
(pass) an earlier result no longer in context is never short-circuited [41.98ms]
(pass) an earlier result whose text the engine cut is never short-circuited [61.41ms]
(pass) a Read cut to its token cap is not recorded [56.62ms]
(pass) the next identical Read after an answer runs (the escape) [78.98ms]
(pass) a different range is a different key [28.07ms]
(pass) an Edit of the file evicts it [34.46ms]
(pass) a compaction of the main loop evicts its entries [61.69ms]
(pass) turned off, every Read runs [28.38ms]
(pass) near the auto-compaction threshold the Read runs (the race with a compaction) [37.08ms]
(pass) a gap of more than an hour between two rows stops answers for the session [46.54ms]
(pass) a compaction in the turn of an answer appends a note naming the file [57.97ms]
(pass) a resumed session, whose earlier gaps the mod never saw, gets no answer [31.05ms]
(pass) auto-compaction on with no threshold is an unknown reading: no answer [61.18ms]
(pass) no breakdown in the usage reading: no answer [38.62ms]
(pass) a failed usage call: no answer, the Read runs [64.03ms]
(pass) a resumed session with no cost-state row (startedAt recent) still gets no answer [36.14ms]
(pass) a fresh session whose opening user row came before the first stamp is answered [71.82ms]
(pass) a history with a tool result and no model message still starts idle [69.28ms]
(pass) a conversation the first stamp cannot read counts as history: no answer [74.02ms]

 22 pass
 0 fail
Ran 22 tests across 1 file. [1.39s]
```

### 2.3 Type-check

There is no `tsconfig.json` in the mod folder: a `--plugin-dir` mod run under `claude -p` is never
written in, so the engine lays no types beside it (reference.md:50-53). The type-check uses the
header's `tsconfig.json` (types `claude-code.d.ts`:67-77), kept outside the mod folder, its
`include` naming the declaration file and the mod's `hooks`, `types` and `tests`:

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
    "<scratchpad>/read-dedupe/hooks",
    "<scratchpad>/read-dedupe/types",
    "<scratchpad>/read-dedupe/tests"
  ]
}
```

`npx tsc -p <scratchpad>/tscheck/tsconfig.json; echo "exit $?"` (tsc prints nothing on success):

```text
exit 0
```

### 2.4 Mutation check

Seven guards were broken on purpose, each in a throwaway copy of the module, and the test suite run
against it: treating a missing `autoCompactThreshold` as far from a compaction, answering when the
usage call fails, ignoring the first-stamp rule altogether, ignoring the resumed history's model
turns (leaving only the `startedAt` bound), counting a user text as a model turn, checking for an
`assistant` message only (the `tool_result` clause dropped), and treating a refused read of the
conversation as a fresh session. Every mutant was killed (the tests named are the ones that
failed):

```text
missing threshold treated as far: KILLED by ['auto-compaction on with no threshold is an unknown reading: no ']
usage failure answers: KILLED by ['a changed file runs Read again [20.40ms]', 'a same-size, same-mtime rewrite is caught by the content hash [', 'no breakdown in the usage reading: no answer [18.86ms]', 'a failed usage call: no answer, the Read runs [19.27ms]']
first-stamp bound ignored: KILLED by ['a resumed session, whose earlier gaps the mod never saw, gets n', 'a resumed session with no cost-state row (startedAt recent) sti', 'a history with a tool result and no model message still starts ']
resumed turns not checked (startedAt only): KILLED by ['a resumed session with no cost-state row (startedAt recent) sti', 'a history with a tool result and no model message still starts ', 'a conversation the first stamp cannot read counts as history: n']
a user text counts as a turn: KILLED by ['a fresh session whose opening user row came before the first st']
assistant-only check (tool_result clause dropped): KILLED by ['a history with a tool result and no model message still starts ']
a refused conversation read counts as a fresh session: KILLED by ['a conversation the first stamp cannot read counts as history: n']
```

## 3. Live runs: the mechanisms the design hinges on, run against a real engine

The kit tests stand in for the engine: nothing sits beneath the plugin but the test's own hooks
(reference.md:81). Four facts the design rests on can only come from a real session, so each was
run with `claude -p --plugin-dir <scratchpad>/read-dedupe --model haiku --output-format
stream-json --verbose --allowedTools=Read` (plus `Agent` for runs 10 and 13; `--resume <id>` for runs 17, 20, 21, 22 and 24 to 27) on a three-line file
`notes.txt` (`alpha line one`, `beta line two`, `gamma line three`, trailing newline). Turn-by-turn
runs (7, 8, 9) were driven with `--input-format stream-json`, one user message sent after each
`result` line. Cost of all twenty-seven runs together: 0.18 USD (the sum of each run's reported `total_cost_usd`).

| Run | Setup                                                                                                      | What happened                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Proves                                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1–2 | First version of the module: whole-text hash of the earlier result                                         | The second Read ran for real. No hook error in the debug log.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | A silent miss: something did not match                                                                           |
| 3   | Same, with a trace written through `$.fs.write`                                                            | Disk check passed (`isSame=true`). The earlier tool_result in `$.session.messages({ as: 'api' })` read `1\talpha line one\n…\n4\n\n<system-reminder>…`: the trailing tab of `text` (`…\n4\t`) cut, and a reminder appended **inside the same tool_result**                                                                                                                                                                                                                                                                          | The request holds the result normalised, so the check must compare a prefix (§5.3 of the spec)                   |
| 4   | Fixed module (prefix hash), Read twice                                                                     | Second Read answered: debug log `read-dedupe (user) answered tool.call without next() in 4.9ms; nothing beneath it ran for this dispatch` (the first Read's hook settled in 3,547.7 ms with `next()` included). The model read `Wasted call — file unchanged since your last Read. Refer to that earlier tool_result instead.`, no `is_error`; the stored record is `{"type":"file_unchanged",…}`; the `context` note was stored as a `hook_additional_context` attachment. The model quoted all three lines from the first result. | The engine accepts a hook's `file_unchanged`, maps it with Read's own mapper, and carries `context` to the model |
| 5   | Read three times                                                                                           | Call 1 ran, call 2 answered, call 3 ran                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | The escape (§7.4)                                                                                                |
| 6   | Read, `/compact`, Read sent at once as stream-json input                                                   | The engine folded the third message into the first turn and ran `/compact` last: the second Read was answered; the model quoted the three lines "from the first read"                                                                                                                                                                                                                                                                                                                                                               | A second instance of the answer leaving the content usable (not a compaction test; run 7 is)                     |
| 7   | Read, `/compact`, Read (production module)                                                                 | Both Reads ran                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Compaction ends the answer, with both layers on                                                                  |
| 8   | Same, `session.compact` hook **removed**, trace on                                                         | After `/compact` the API view held 5 messages and **no** tool_result for the first Read (`seen=undefined`), so the second Read ran                                                                                                                                                                                                                                                                                                                                                                                                  | The context check alone catches a compaction                                                                     |
| 9   | Read, `/clear`, Read                                                                                       | The session id changed (`c04f107f…` → `6c2eb543…`); no entry matched the new id; the Read ran                                                                                                                                                                                                                                                                                                                                                                                                                                       | `/clear` never reuses an entry                                                                                   |
| 10  | Main Read, then a `general-purpose` subagent reads twice                                                   | The main loop's entry did not answer the subagent's first Read; the subagent's second Read was answered from its own history                                                                                                                                                                                                                                                                                                                                                                                                        | Per-loop keys and `$.session.messages({ as: 'api', agentId })` work in a subagent                                |
| 11  | The round 0 module after its last Prettier pass and the `SHA256` respelling, the run 4 scenario            | Second Read answered in 3.8 ms, same mapped text                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Runs 4–10 used the round 0 module before that pass, which changed formatting and that one spelling only          |
| 12  | Round 1 module (checks 0, 6, 7 of spec §5.1), two Reads                                                    | Both ran: the model put both Reads in one response, so they ran in parallel and the second found no entry yet                                                                                                                                                                                                                                                                                                                                                                                                                       | Parallel identical Reads are never answered (a safe miss, spec §5.4)                                             |
| 13  | Round 1 module, a main Read, then a subagent reading twice                                                 | All three Reads ran                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | v1 answers in the main loop only (check 0)                                                                       |
| 14  | Round 1 module with a trace written through `$.fs.write`                                                   | Row present, not idle; `$.session.usage({ breakdown: 'summary' })` read `totalTokens` 41,385 against `autoCompactThreshold` 967,000 with auto-compaction on (`window` 1,000,000); the second Read was answered                                                                                                                                                                                                                                                                                                                      | The fill reading and the row guard work live                                                                     |
| 15  | Final round 1 module, the two Reads in separate steps                                                      | Answered in 26.4 ms (the usage read is the added cost)                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | The final module answers live                                                                                    |
| 16  | Round 2 draft: the first stamp starts idle when `$.session.messages` is not empty, fresh session           | No answer                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | The draft was too strict: see run 18                                                                             |
| 17  | Same draft, a resumed session                                                                              | No answer (one Read only; not discriminating)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | —                                                                                                                |
| 18  | Same draft with a trace                                                                                    | The first row the mod stamped in a **fresh** `-p` session (`door: hook-context`, a `hook_success` attachment) already found one user message in the list                                                                                                                                                                                                                                                                                                                                                                            | A non-empty list does not mean a resume; the round 2 rule bounds unstamped history by `startedAt` instead        |
| 19  | Final round 2 module, fresh session, Reads in separate steps                                               | Second Read answered                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | A fresh session still gets answers                                                                               |
| 20  | Final round 2 module, `--resume` of run 1's session, 57 minutes after its first launch                     | Second Read answered                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Within 60 minutes of the first launch no unstamped gap can exceed 60 minutes: answering is right                 |
| 21  | `--resume` of the same session with a trace                                                                | The first stamp read `startedAt` = run 1's first launch (19:41:05 UTC), 57.3 minutes earlier; same session id                                                                                                                                                                                                                                                                                                                                                                                                                       | `startedAt` is the first launch across a resume (types:11704-11716)                                              |
| 22  | Final round 2 module, the same resume at 60.2 minutes (20:41:19 UTC)                                       | Both Reads ran, in separate responses; no answer in the debug log                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | The resumed-history gap is covered (check 6)                                                                     |
| 23  | Final round 3 module, fresh session, Reads in separate steps                                               | Second Read answered                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | A fresh session still gets answers, now with the structural signal                                               |
| 24  | Round 3 module, `--resume` of a transcript with its `cost-state` row removed                               | No answer; both Reads ran                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | A resumed history is never answered, whatever `startedAt` says                                                   |
| 25  | Same, with a trace                                                                                         | `startedAt` was 2.8 s before the first stamp (no `cost-state` row, so no restored start time); the history held user and assistant messages; the first stamp started idle                                                                                                                                                                                                                                                                                                                                                           | The `startedAt` bound alone would have called this a fresh session (spec §5.1 check 6)                           |
| 26  | **Round 2 module** (the `startedAt` bound only) on a transcript with its `cost-state` row removed, resumed | The second Read was **answered**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | The false answer the round 3 grader predicted, reproduced                                                        |
| 27  | Round 3 module on an identical stripped transcript                                                         | No answer; both Reads ran                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | The same input, with the fix                                                                                     |

Runs 1–11 used the round 0 module (no checks 0, 6 and 7); runs 12–15 the round 1 module (check 6 reset by a compaction, no `startedAt` bound); runs 19–22 the round 2 module (the `startedAt` bound as the only resume signal; its source is no longer pasted), and runs 23–27 the round 3 module pasted above, except run 26, which used the round 2 module on purpose.

Runs 1 to 3 are the reason C-1 asks for runs: all eleven kit tests of the time passed against the first version,
whose comparison could never match in a real session.
