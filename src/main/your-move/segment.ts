/**
 * Transcript entries since the last inspection, tagged for the judge (pure).
 *
 * Tagging comes from each entry's `origin`, never from its position: `human` is the
 * operator, except dispatch prompts, which carry `human` but start with `[Harnu ·`.
 * Everything else that arrives from outside (peer, task-notification, external, no origin)
 * is an agent message. Assistant text is carried whole; tool calls stay summarized.
 */

export type SegmentTag = 'OPERATOR' | 'AGENT_MESSAGE' | 'ASSISTANT' | 'TOOL'

export interface SegmentEntry {
  tag: SegmentTag
  from?: string
  text: string
}

const TOOL_INPUT_CHARS = 120
const MAX_TOOLS_PER_ENTRY = 3
/** Per-line framing the renderer adds around an entry: `[AGENT_MESSAGE from external] ` and a newline. */
const FRAME_CHARS = 48

type Json = Record<string, unknown>

const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is Json => isRecord(b) && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
}

function toolLines(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  const out: string[] = []
  for (const b of content) {
    if (!isRecord(b) || b.type !== 'tool_use') continue
    const input = JSON.stringify(b.input ?? null) ?? 'null'
    out.push(`${String(b.name)}(${input.slice(0, TOOL_INPUT_CHARS)})`)
    if (out.length === MAX_TOOLS_PER_ENTRY) break
  }
  return out
}

export function buildSegment(lines: readonly Record<string, unknown>[]): SegmentEntry[] {
  const out: SegmentEntry[] = []
  for (const e of lines) {
    if (e.isSidechain === true || e.isCompactSummary === true) continue
    const message = isRecord(e.message) ? e.message : {}
    if (e.type === 'user') {
      const content = message.content
      if (Array.isArray(content) && content.some((b) => isRecord(b) && b.type === 'tool_result')) {
        continue
      }
      const origin = isRecord(e.origin) ? e.origin : null
      const kind = origin && typeof origin.kind === 'string' ? origin.kind : 'external'
      if (e.isMeta === true && kind !== 'peer') continue
      const text = textOf(content).trim()
      if (text === '') continue
      const operator = kind === 'human' && !text.startsWith('[Harnu ·')
      out.push(
        operator
          ? { tag: 'OPERATOR', from: kind, text }
          : { tag: 'AGENT_MESSAGE', from: kind, text }
      )
    } else if (e.type === 'assistant') {
      const text = textOf(message.content).trim()
      if (text !== '') out.push({ tag: 'ASSISTANT', text })
      for (const t of toolLines(message.content)) out.push({ tag: 'TOOL', text: t })
    }
  }
  return out
}

function tagLabel(e: SegmentEntry): string {
  return e.tag === 'AGENT_MESSAGE' ? `AGENT_MESSAGE from ${e.from ?? 'unknown'}` : e.tag
}

/** The exact judge input: the open cards, then the segment, one tagged line per entry. */
export function renderForJudge(
  open: readonly { id: string; ask: string }[],
  entries: readonly SegmentEntry[]
): string {
  const cards = JSON.stringify(open.map((c) => ({ id: c.id, ask: c.ask })))
  const lines = entries.map((e) => `[${tagLabel(e)}] ${e.text}`)
  return `OPEN_CARDS: ${cards}\n\nSEGMENT:\n${lines.join('\n')}`
}

/** The enrichment input: the detector input plus the candidates it must complete, numbered from 0. */
export function renderForEnrich(
  open: readonly { id: string; ask: string }[],
  entries: readonly SegmentEntry[],
  candidates: readonly unknown[]
): string {
  const numbered = candidates.map((c, index) => ({ index, ...(c as object) }))
  return `${renderForJudge(open, entries)}\n\nCANDIDATES: ${JSON.stringify(numbered)}`
}

function cut(text: string, max: number): [string, string] {
  let at = Math.min(max, text.length)
  const code = text.charCodeAt(at - 1)
  if (at < text.length && code >= 0xd800 && code <= 0xdbff) at -= 1 // keep a surrogate pair whole
  return [text.slice(0, at), text.slice(at)]
}

/**
 * Split in order into parts that each fit `maxChars` once rendered. An entry larger than a
 * part is cut into same-tag pieces: no text is ever dropped.
 */
export function splitSegment(entries: readonly SegmentEntry[], maxChars: number): SegmentEntry[][] {
  const room = Math.max(1, maxChars - FRAME_CHARS)
  const parts: SegmentEntry[][] = []
  let cur: SegmentEntry[] = []
  let used = 0
  const flush = (): void => {
    if (cur.length > 0) parts.push(cur)
    cur = []
    used = 0
  }
  for (const e of entries) {
    let rest = e.text
    do {
      const free = room - used
      if (rest.length <= free) {
        cur.push({ ...e, text: rest })
        used += rest.length + FRAME_CHARS
        rest = ''
      } else if (used > 0 && rest.length <= room) {
        flush() // fits whole in a fresh part
      } else {
        if (free <= 0) flush()
        const [head, tail] = cut(rest, Math.max(1, room - used))
        cur.push({ ...e, text: head })
        flush()
        rest = tail
      }
    } while (rest.length > 0)
  }
  flush()
  return parts
}

export const hasOperatorEntry = (entries: readonly SegmentEntry[]): boolean =>
  entries.some((e) => e.tag === 'OPERATOR')

/** Worth a judge call: anything but tool summaries alone. */
export const isJudgeable = (entries: readonly SegmentEntry[]): boolean =>
  entries.some((e) => e.tag !== 'TOOL')

export const hasAssistantText = (entries: readonly SegmentEntry[]): boolean =>
  entries.some((e) => e.tag === 'ASSISTANT')
