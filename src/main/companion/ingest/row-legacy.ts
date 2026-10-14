/**
 * The legacy twin of the `row` parity stream (T455 spec §7.3): what Harnu's reader shows for a
 * transcript, read when a main-loop turn ends, never stored. Three reads, all bounded:
 *
 *  - `header`: the reader's own header scrape, injected (`host.ts` passes the slug pass's cached,
 *    incremental scrape, so a turn end costs only the bytes appended since the last pass). It is
 *    the reader's value, not a copy of its rules: the first prompt, the `last-prompt` line, the
 *    custom title and the user-row count, with the 2 MiB head cap.
 *  - `tail`: one read of the file's last 512 KB (the reader's tail window): the last assistant
 *    text, where the push's `lastUuid` sits (M1), the user rows the CLI's `last-prompt` line can
 *    name (classed by their stored shape, as W0's `p1-prompts.ts` classes them), and
 *    `stall-detect`'s call count over that tail.
 *  - `firstRow`: the first prompt row of the head, read only when a first-prompt divergence needs
 *    a class (its length and whether it has a word inside the redaction window).
 *
 * The path is the identity adapter's validated one (`transcript-path.ts`). Every read is
 * best-effort: an error is "no legacy value", never a throw.
 */

import { open } from 'node:fs/promises'
import { extractCommandName, firstRealPrompt } from '../../claude-reader-derive'
import { deriveStagnation } from '../../stall-detect'
import { isNoiseEntry } from '../../transcript-truth'
import {
  hasWindowWord,
  HEAD_CAP_BYTES,
  TAIL_WINDOW_BYTES,
  type RowLegacyView,
  type StoredShape
} from './row-parity-core'

export interface LegacyHeader {
  firstPrompt: string
  lastPrompt: string
  customTitle: string
  userMessageCount: number
}

export type LegacyTail = Pick<
  RowLegacyView,
  'mtimeMs' | 'size' | 'lastAssistant' | 'uuidFound' | 'rowsAfter' | 'recentPrompts' | 'toolCalls5m'
>

export type FirstRowFacts = NonNullable<RowLegacyView['firstRow']>

export interface RowLegacySource {
  header(path: string): Promise<LegacyHeader | null>
  tail(path: string, lastUuid: string | null): Promise<LegacyTail | null>
  firstRow(path: string): Promise<FirstRowFacts | null>
}

/** At most this many recent prompt rows are kept for naming a `last-prompt` line. */
const RECENT_PROMPTS = 64

type Entry = Record<string, unknown>

/** The reader's `userMessageText`: a string, or the text blocks joined; null for a tool result. */
function userText(msg: unknown): string | null {
  const c = (msg as { content?: unknown } | null)?.content
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return null
  if (c.some((b) => (b as { type?: unknown } | null)?.type === 'tool_result')) return null
  return c
    .map((b) =>
      (b as { type?: unknown } | null)?.type === 'text'
        ? String((b as { text?: unknown }).text ?? '')
        : ''
    )
    .join('')
}

function assistantText(msg: unknown): string {
  const c = (msg as { content?: unknown } | null)?.content
  if (typeof c === 'string') return c
  if (!Array.isArray(c)) return ''
  return c
    .filter((b) => (b as { type?: unknown } | null)?.type === 'text')
    .map((b) => String((b as { text?: unknown }).text ?? ''))
    .join(' ')
}

/** A stored user row's class (W0 `p1-prompts.ts` `classify`, folded to the parity classes). */
export function storedShape(e: Entry, text: string): StoredShape {
  const kind = (e.origin as { kind?: unknown } | undefined)?.kind
  const cmd = extractCommandName(text)
  if (typeof e.scheduledTaskId === 'string') return 'scheduled'
  if (kind === 'human') return cmd ? 'command' : 'typed'
  if (kind === 'peer') return 'peer'
  if (kind === 'task-notification') return 'task-notification'
  if (kind === 'plugin' || kind === 'bridge') return 'plugin-bridge'
  if (typeof kind === 'string') return 'other'
  const t = text.trimStart()
  if (t.startsWith('Another Claude session sent a message') || t.startsWith('<teammate-message')) {
    return 'teammate'
  }
  return 'other'
}

/** The text the CLI writes in `last-prompt` for a row: `/name args` for a slash command. */
function namedText(text: string): string {
  const name = extractCommandName(text)
  if (!name) return text
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() ?? ''
  return args ? `${name} ${args}` : name
}

const isMainRow = (e: Entry): boolean =>
  (e.type === 'user' || e.type === 'assistant') && e.isSidechain !== true

function parseLines(text: string, skipFirst: boolean): Entry[] {
  const lines = text.split('\n')
  if (skipFirst) lines.shift() // a partial line where the read started
  const out: Entry[] = []
  for (const line of lines) {
    if (!line) continue
    try {
      const v: unknown = JSON.parse(line)
      if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v as Entry)
    } catch {
      // a torn last line
    }
  }
  return out
}

async function readRange(
  path: string,
  fromEnd: number | null,
  max: number
): Promise<{ text: string; size: number; mtimeMs: number; start: number } | null> {
  let fh: Awaited<ReturnType<typeof open>> | null = null
  try {
    fh = await open(path, 'r')
    const st = await fh.stat()
    const start = fromEnd === null ? 0 : Math.max(0, st.size - fromEnd)
    const len = Math.min(max, st.size - start)
    const buf = Buffer.alloc(len)
    const { bytesRead } = await fh.read(buf, 0, len, start)
    return { text: buf.toString('utf8', 0, bytesRead), size: st.size, mtimeMs: st.mtimeMs, start }
  } catch {
    return null
  } finally {
    await fh?.close().catch(() => undefined)
  }
}

export function createRowLegacySource(deps: {
  header(path: string): Promise<LegacyHeader | null>
}): RowLegacySource {
  return {
    async header(path) {
      try {
        return await deps.header(path)
      } catch {
        return null
      }
    },

    async tail(path, lastUuid) {
      const r = await readRange(path, TAIL_WINDOW_BYTES, TAIL_WINDOW_BYTES)
      if (!r) return null
      const lines = parseLines(r.text, r.start > 0)
      const entries = lines.filter((e) => !isNoiseEntry(e))
      let lastAssistant: string | null = null
      // The push's `lastUuid` can be ANY folded row, a `system` one included (the turn's
      // `turn_duration`), so it is looked for on every line; what follows it and matters to the
      // comparison is a user or assistant row the push has not folded yet (M1).
      let found = -1
      let rowsAfter = 0
      const recent: { text: string; shape: StoredShape }[] = []
      lines.forEach((e, i) => {
        const isLast = lastUuid !== null && e.uuid === lastUuid
        if (isLast) {
          found = i
          rowsAfter = 0
        }
        if (!isMainRow(e)) return
        if (found >= 0 && !isLast) rowsAfter++
        if (e.type === 'assistant') {
          const t = assistantText(e.message)
          if (t.trim() !== '') lastAssistant = t
        } else {
          const t = userText(e.message)
          if (t !== null && t.trim() !== '') {
            recent.push({ text: namedText(t), shape: storedShape(e, t) })
            if (recent.length > RECENT_PROMPTS) recent.shift()
          }
        }
      })
      return {
        mtimeMs: r.mtimeMs,
        size: r.size,
        lastAssistant,
        uuidFound: lastUuid === null ? null : found >= 0,
        rowsAfter,
        recentPrompts: recent,
        toolCalls5m: deriveStagnation(entries).calls
      }
    },

    async firstRow(path) {
      const r = await readRange(path, null, HEAD_CAP_BYTES)
      if (!r) return null
      for (const e of parseLines(r.text, false)) {
        if (e.type !== 'user' || e.isSidechain === true) continue
        const t = userText(e.message)
        if (!t || firstRealPrompt([t]) === '') continue // the reader skips it too
        return { shape: storedShape(e, t), rawLength: t.length, windowWord: hasWindowWord(t) }
      }
      return null
    }
  }
}
