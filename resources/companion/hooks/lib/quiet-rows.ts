/**
 * The quiet rows' parser (T589). Pure and `$`-free (MOD-1): it reads what a `UserMessage` row the
 * operator did not type says (a peer's report, a task notice, a loop tick) and turns it into the one
 * line the `UserMessage` hook draws. Display only: the stored message, and what the model reads, are
 * never touched, and ctrl+o always shows the engine's own row.
 *
 * Fail safe is the whole contract: nothing here throws, and a row that parses to nothing is `null`
 * (the caller returns the engine's drawing). A line is cut at the edge by the view, never by hiding
 * words: the full text is one ctrl+o away.
 */

/** The only origins this feature acts on (AC-1). Everything else, the operator's own words included, is left alone. */
export const QUIET_KINDS: ReadonlySet<string> = new Set([
  'scheduled-trigger',
  'peer',
  'peer-send-message',
  'task-notification'
])

/** A chip's text is cut here; the view truncates at the terminal's edge on top of it. */
export const CHIP_TEXT_MAX = 300

export type ChipTone = 'inactive' | 'success' | 'error' | 'warning' | 'claude'
export interface Chip {
  glyph: '✉' | '◌' | '✓' | '✗' | '!' | '⟳' | '·'
  tone: ChipTone
  text: string
}

export interface RowFrom {
  name?: string
}
export interface RowTask {
  status?: string
  durationMs?: number
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null)
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()
const cut = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1)}…`)

// Regexes that end a line are built from strings: the API-surface scan reads a `$` in code as the engine's `$` (MOD-1).
const SENTENCE = new RegExp('^(.+?[.!?])(?:\\s|$)')

/** The first sentence of a line: up to a `.`, `!` or `?` that ends a word. A line with none stays whole. */
export function firstSentence(line: string): string {
  const l = oneLine(line.replace(/^[#>*\-\s]+/, ''))
  const m = SENTENCE.exec(l)
  return m ? m[1] : l
}

/** `2m 2s`, `45s`, `1h 3m`; `null` for a figure that is not a duration. */
export function duration(ms: unknown): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 === 0 ? `${m}m` : `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`
}

// Built from strings: the API-surface scan reads a `$` in code as the engine's `$` (MOD-1).
const FRAMING_LINE = new RegExp(
  '^(?:Another Claude session sent a message:?|This came from another Claude session\\b.*|</?cross-session-message\\b.*|</?teammate-message\\b.*)$',
  'i'
)

/** The row's own lines, less any framing a notice or a delivery still carries. */
function bodyLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !FRAMING_LINE.test(l))
}

const REPORT_HEADER = new RegExp('^Report for session \\S+ · mission (\\S+) · step (\\S+)\\s*$')

// The marker the engine puts in front of an idle notice that reaches a session as a notification.
const IDLE_MARKER = new RegExp('\\[Cross-session idle notice\\]\\s*', 'gi')

/** The row's text with the engine's framing and the idle marker removed: what the sender wrote. */
function unframed(raw: string): string {
  return bodyLines(raw.replace(IDLE_MARKER, '\n')).join('\n')
}

/** The JSON object inside a text, from its first `{` to its last `}`, or `null`. */
function jsonIn(text: string): Record<string, unknown> | null {
  const a = text.indexOf('{')
  const b = text.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try {
    const o: unknown = JSON.parse(text.slice(a, b + 1))
    return typeof o === 'object' && o !== null && !Array.isArray(o)
      ? (o as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/**
 * An idle notice, in any of its shapes: the bare JSON, the JSON inside a `<teammate-message>` or
 * `<cross-session-message>` wrapper, or behind the `[Cross-session idle notice]` marker, under a
 * peer or a task-notification origin. Plain words behind the marker are an idle chip of those words.
 */
function idleChip(raw: string, from: RowFrom | undefined): Chip | null {
  const body = unframed(raw)
  const r = jsonIn(body)
  if (r !== null && r.type === 'idle_notification') {
    const who = str(r.from) ?? str(from?.name) ?? 'teammate'
    const at = typeof r.timestamp === 'string' ? new Date(r.timestamp) : null
    const when =
      at && !Number.isNaN(at.getTime())
        ? ` ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
        : ''
    const said = str(r.result) ? ` · «${firstSentence(String(r.result))}»` : ''
    return { glyph: '◌', tone: 'inactive', text: cut(`${who} idle${when}${said}`, CHIP_TEXT_MAX) }
  }
  if (new RegExp('\\[Cross-session idle notice\\]', 'i').test(raw) && body !== '') {
    return { glyph: '◌', tone: 'inactive', text: cut(oneLine(body), CHIP_TEXT_MAX) }
  }
  return null
}

/** A peer's message (mock 03): who, the report's mission and step when it has the header, the first sentence. */
export function peerChip(text: unknown, from: RowFrom | undefined): Chip | null {
  const raw = str(text)
  if (raw === null) return null
  const idle = idleChip(raw, from)
  if (idle) return idle
  const lines = bodyLines(raw)
  if (lines.length === 0) return null
  const name = str(from?.name) ?? 'peer'
  const head = REPORT_HEADER.exec(lines[0])
  const rest = head ? lines.slice(1) : lines
  const summary = rest.find((l) => /^Summary:\s*\S/.test(l))
  const said = summary
    ? firstSentence(summary.replace(/^Summary:\s*/, ''))
    : firstSentence(rest[0] ?? '')
  const lead = head ? ` report · ${head[1]} ${head[2]}` : ''
  const tail = said !== '' ? ` · ${said}` : ''
  return { glyph: '✉', tone: 'inactive', text: cut(`${name}${lead}${tail}`, CHIP_TEXT_MAX) }
}

const BG_TASK = new RegExp(
  '^Background command "(.+)" (completed|failed|was stopped)(?: \\(exit code (-?\\d+)\\))?\\.?$'
)

/** A background task's notice (mock 03): its summary, its exit code and how long it ran. */
export function noticeChip(text: unknown, task: RowTask | undefined): Chip | null {
  const idle = idleChip(str(text) ?? '', undefined)
  if (idle) return idle
  const lines = bodyLines(str(text) ?? '')
  if (lines.length === 0) return null
  const line = oneLine(lines.join(' '))
  const bg = BG_TASK.exec(line)
  const status =
    str(task?.status) ??
    (bg ? (bg[2] === 'completed' ? 'completed' : bg[2] === 'failed' ? 'failed' : 'killed') : null)
  const glyph =
    status === 'completed' ? '✓' : status === 'failed' ? '✗' : status === 'killed' ? '!' : '·'
  const tone: ChipTone =
    glyph === '✓' ? 'success' : glyph === '✗' ? 'error' : glyph === '!' ? 'warning' : 'inactive'
  const took = duration(task?.durationMs)
  const exit = bg && bg[3] !== undefined ? ' · exit ' + bg[3] : ''
  const core = bg ? 'bg task ' + bg[1] + exit : firstSentence(line)
  const after = took ? ' · ' + took : ''
  return { glyph, tone, text: cut(core + after, CHIP_TEXT_MAX) }
}

/** The loop tick's first line: `/harnu:mission tick · mnt-<8 hex>` and nothing else on it. */
const TICK_LINE = new RegExp('^/harnu:mission tick · (mnt-[0-9a-f]{8})[ \\t]*$')

/** The mission id a tick prompt names on its first line, or `null` (any other first line, even a near miss). */
export function tickMissionId(text: unknown): string | null {
  if (typeof text !== 'string') return null
  const m = TICK_LINE.exec(text.split(/\r?\n/, 1)[0])
  return m ? m[1] : null
}

/** How far into a row's text the tick line may sit: a framing line or two may stand before it. */
const TICK_SEARCH_LINES = 6

/** The mission id of a fired tick as the engine appends it, the line being anywhere in its first lines. */
export function tickMissionIn(text: unknown): string | null {
  if (typeof text !== 'string') return null
  for (const l of text.split(/\r?\n/, TICK_SEARCH_LINES)) {
    const m = TICK_LINE.exec(l)
    if (m) return m[1]
  }
  return null
}

/** A scheduled row with no live card to draw (no mission id, no pushed state): its first line, plain. */
export function tickChip(text: unknown): Chip | null {
  const first = bodyLines(str(text) ?? '')[0]
  if (first === undefined) return null
  return {
    glyph: '⟳',
    tone: 'inactive',
    text: cut(oneLine(first.replace(/^\/harnu:mission\s+/, '')), CHIP_TEXT_MAX)
  }
}

/** The chip for a row of one of {@link QUIET_KINDS}, or `null` when there is nothing to say. */
export function rowChip(
  kind: string,
  text: unknown,
  from: RowFrom | undefined,
  task: RowTask | undefined
): Chip | null {
  switch (kind) {
    case 'peer':
    case 'peer-send-message':
      return peerChip(text, from)
    case 'task-notification':
      return noticeChip(text, task)
    case 'scheduled-trigger':
      return tickChip(text)
    default:
      return null
  }
}

/** A `from` or `task` prop as the lib reads it: an object, or `undefined` (a malformed one is never trusted). */
export function plainObject<T extends object>(v: unknown): T | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as T) : undefined
}
