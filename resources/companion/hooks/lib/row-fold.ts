import { ROW_TEXT_MAX, ROW_TEXT_MAX_BYTES } from '../contract'
import { redactForWire } from './redact-wire'

/**
 * The compact row (T455 spec §5.2): what the sidebar and the session preview read for a live
 * session, folded from the rows the main conversation keeps in THIS process (`session.append`, the
 * row as stored). Pure and `$`-free (MOD-1), so the host's parity gate can run the same fold.
 *
 * Process-local on purpose: a resumed or forked history is the host's cold baseline (its reader
 * already folded it), and loads raise no append, so nothing is seeded (§0 fact 2).
 *
 * The rules are the spec's §5.2 table as the W0 findings amend it (04-w0-findings.md §8):
 *  - M1: `lastUuid` (and `lastRowAt`, the same row's time) folds only main-loop rows whose door is
 *    not `hook-context`. A settings hook's row can be appended and never written.
 *  - M2: `title` is the latest `session_title`, which carries only a custom title. Recorded only.
 *  - M3a: `lastPrompt` is a typed prompt or a typed slash command (origin `composer`); every
 *    machine-made row is skipped.
 *  - M3b: `firstPrompt` mirrors the legacy reader (`claude-reader.ts` header scan): the first
 *    main-loop user row with text, any door and origin, a slash command resolved to its name;
 *    minus `peer` and plugin-meta rows (P2W2 §7.7).
 */

export const ROW_FOLD_VERSION = 1
/** Every text field's cap in 16-bit code units, after whitespace is collapsed (spec §5.3). */
export const TEXT_MAX = ROW_TEXT_MAX
/** How much of a text is redacted before the cap: a secret near the cut is never halved. */
export const REDACT_WINDOW = 8_192

/**
 * Text fields: `null` = none seen by this process; `undefined` = unknown (the module reloaded and
 * texts are never persisted, §5.5), sent as an absent field so the host keeps what it had.
 */
export interface Row {
  firstPrompt?: string | null
  lastPrompt?: string | null
  lastAssistant?: string | null
  /** The latest `session_title`; recorded for parity only. */
  title?: string | null
  /** `tool_use` blocks of main-loop responses; recorded for parity only. */
  toolCalls: number
  /** `tool_use` blocks of subagents' responses, kept apart. */
  subagentToolCalls: number
  /** Main-loop `user` rows since this process started, tool results included. */
  userRows: number
  /** Epoch ms of the last folded row (the mod's clock); null before the first. */
  lastRowAt: number | null
  /** The uuid of the last folded row: aligns the push with the transcript for parity. */
  lastUuid: string | null
}

/** The fold: the row, whether the first prompt was taken (even if withheld), the newest uuids. */
export interface Fold {
  row: Row
  firstTaken: boolean
  recent: string[]
}

/** What survives a reload in `$.state`: counts, the time and the uuid. Never a text (§5.5 rule 1). */
export type RowCounts = Pick<
  Row,
  'toolCalls' | 'subagentToolCalls' | 'userRows' | 'lastRowAt' | 'lastUuid'
>

/** The `session.row` payload (contract `EventPayloads['session.row']`). */
export interface RowWire extends RowCounts {
  fold: typeof ROW_FOLD_VERSION
  firstPrompt?: string | null
  lastPrompt?: string | null
  lastAssistant?: string | null
  title?: string | null
}

/** One `session.append` as the step hands it: the event's door, origin and agent, the stored row. */
export interface AppendedRow {
  door: string
  origin?: { kind?: string; asUser?: unknown } | null
  agentId?: string
  uuid?: string | null
  message: {
    type?: string
    role?: string
    isMeta?: boolean
    content: unknown
  }
}

export const emptyFold = (): Fold => ({
  row: {
    firstPrompt: null,
    lastPrompt: null,
    lastAssistant: null,
    title: null,
    toolCalls: 0,
    subagentToolCalls: 0,
    userRows: 0,
    lastRowAt: null,
    lastUuid: null
  },
  firstTaken: false,
  recent: []
})

/** After a reload: the counts come back, every text is unknown, the first prompt included. */
export const restoredFold = (c: RowCounts): Fold => ({
  row: {
    toolCalls: c.toolCalls,
    subagentToolCalls: c.subagentToolCalls,
    userRows: c.userRows,
    lastRowAt: c.lastRowAt,
    lastUuid: c.lastUuid
  },
  firstTaken: true,
  recent: c.lastUuid !== null ? [c.lastUuid] : []
})

/**
 * After a reload whose `session.start` came after rows were already folded in this load (D6): the
 * saved counts plus what this load folded; the texts this load saw stay, the first prompt unknown.
 */
export function mergeRestored(c: RowCounts, f: Fold): Fold {
  const r = f.row
  return {
    row: {
      ...(r.lastPrompt !== null && r.lastPrompt !== undefined ? { lastPrompt: r.lastPrompt } : {}),
      ...(r.lastAssistant !== null && r.lastAssistant !== undefined
        ? { lastAssistant: r.lastAssistant }
        : {}),
      ...(r.title !== null && r.title !== undefined ? { title: r.title } : {}),
      toolCalls: c.toolCalls + r.toolCalls,
      subagentToolCalls: c.subagentToolCalls + r.subagentToolCalls,
      userRows: c.userRows + r.userRows,
      lastRowAt: r.lastRowAt ?? c.lastRowAt,
      lastUuid: r.lastUuid ?? c.lastUuid
    },
    firstTaken: true,
    recent: [...f.recent]
  }
}

export const countsOf = (r: Row): RowCounts => ({
  toolCalls: r.toolCalls,
  subagentToolCalls: r.subagentToolCalls,
  userRows: r.userRows,
  lastRowAt: r.lastRowAt,
  lastUuid: r.lastUuid
})

/** The wire payload: an unknown text is left out, a `null` one is sent. */
export function wireOf(r: Row): RowWire {
  const out: RowWire = { fold: ROW_FOLD_VERSION, ...countsOf(r) }
  if (r.firstPrompt !== undefined) out.firstPrompt = r.firstPrompt
  if (r.lastPrompt !== undefined) out.lastPrompt = r.lastPrompt
  if (r.lastAssistant !== undefined) out.lastAssistant = r.lastAssistant
  if (r.title !== undefined) out.title = r.title
  return out
}

/** A sane row from what `$.state` held; null when it is not one. */
export function sanitizeCounts(raw: unknown): RowCounts | null {
  if (typeof raw !== 'object' || raw === null) return null
  const c = raw as Record<string, unknown>
  const count = (v: unknown): number | null =>
    typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null
  const toolCalls = count(c.toolCalls)
  const subagentToolCalls = count(c.subagentToolCalls)
  const userRows = count(c.userRows)
  if (toolCalls === null || subagentToolCalls === null || userRows === null) return null
  const at = c.lastRowAt
  const uuid = c.lastUuid
  return {
    toolCalls,
    subagentToolCalls,
    userRows,
    lastRowAt: typeof at === 'number' && Number.isFinite(at) ? at : null,
    lastUuid: typeof uuid === 'string' && uuid !== '' && uuid.length <= UUID_MAX ? uuid : null
  }
}

// ---- text ------------------------------------------------------------------------------------

/**
 * Where a row's raw text is cut before any parsing (verifiers' D2). The legacy reader reads a
 * whole line under its 2 MiB head cap; the fold needs 240 characters, so it reads at most this
 * much, cut back to a whole word, and every wrapper scan below is linear. A row whose wrappers
 * run past this cap reads differently from the legacy reader (a known, stated divergence).
 */
export const RAW_MAX = 65_536
/** Every text field's cap in UTF-8 bytes as JSON writes it, so four texts stay ~1.5 KB (D6). */
export const TEXT_MAX_BYTES = ROW_TEXT_MAX_BYTES
/**
 * The doors the fold reads, and the `session.append` registration's matcher (register.ts): every
 * door of the engine's `SessionAppendDoor` (2.1.295 types) but `attachment`. An attachment row is
 * not hooked: routing it through the worker tips the race between a background subagent and the
 * main turn (docs/dev/companion-mod.md, "Known engine effect"), and the fold reads nothing from it
 * but its uuid and time. A door the engine adds later is not folded: 2.1.299 appends a queued
 * `claude -p` prompt on a `queue` door before `session.start` and never writes it (the prompt row
 * that follows is the one the transcript keeps), so counting it would add a user row the file
 * does not have.
 */
export const FOLDED_DOORS = [
  'prompt',
  'command',
  'response',
  'tool-result',
  'tool-message',
  'delivery',
  'hook-context',
  'note',
  'compaction',
  'notice'
] as const
const FOLDED: ReadonlySet<string> = new Set(FOLDED_DOORS)

/** The newest uuids folded, kept to drop a row seen twice (D6). */
const RECENT_UUIDS = 64
/** A uuid longer than this is not one: `lastUuid` stays as it was. */
const UUID_MAX = 64

const isSpace = (c: number): boolean =>
  c === 0x20 ||
  (c >= 0x09 && c <= 0x0d) ||
  c === 0xa0 ||
  c === 0x1680 ||
  (c >= 0x2000 && c <= 0x200a) ||
  c === 0x2028 ||
  c === 0x2029 ||
  c === 0x202f ||
  c === 0x205f ||
  c === 0x3000 ||
  c === 0xfeff

/**
 * `s` cut at `max`, back to the last whitespace at or before the cut, so no word is ever halved:
 * a token the cut would split is dropped whole. `s` itself when it fits; `null` when there is no
 * whitespace to cut at (one word longer than `max`: nothing can be shipped safely).
 */
export function wholeWords(s: string, max: number): string | null {
  if (s.length <= max) return s
  for (let i = max; i > 0; i--) if (isSpace(s.charCodeAt(i))) return s.slice(0, i)
  return null
}

/**
 * Control characters that are not whitespace go, and a lone surrogate becomes U+FFFD (JSON writes
 * each as a 6-byte escape, D6). Done BEFORE redaction, so a token a control split is matched.
 */
const REPLACEMENT = String.fromCharCode(0xfffd)

function stripControls(s: string): string {
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  const controls = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g
  const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g
  return s.replace(controls, '').replace(lone, REPLACEMENT)
}

/** What a code point costs inside a JSON string, in UTF-8 bytes (controls are stripped first). */
function jsonBytes(cp: number): number {
  if (cp === 0x22 || cp === 0x5c) return 2
  if (cp < 0x20) return 6
  if (cp < 0x80) return 1
  if (cp < 0x800) return 2
  if (cp < 0x10000) return 3
  return 4
}

/**
 * Collapses whitespace and caps the text at TEXT_MAX 16-bit code units and TEXT_MAX_BYTES bytes, never
 * inside a surrogate pair; a cut text ends in '…'.
 */
export function clip(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim()
  let units = 0
  let bytes = 0
  let fitEnd = -1 // where the text is cut if it does not fit whole (room left for the '…')
  for (let i = 0; i < one.length;) {
    const cp = one.codePointAt(i)!
    const w = cp > 0xffff ? 2 : 1
    const b = jsonBytes(cp)
    if (fitEnd < 0 && (units + w > TEXT_MAX - 1 || bytes + b > TEXT_MAX_BYTES - 3)) fitEnd = i
    units += w
    bytes += b
    if (units > TEXT_MAX || bytes > TEXT_MAX_BYTES) return one.slice(0, fitEnd) + '…'
    i += w
  }
  return one
}

/**
 * A text for the wire (spec §5.5 rule 2, verifiers' D1). Control characters stripped, whitespace
 * collapsed, then cut to REDACT_WINDOW on a WHOLE WORD: the redaction never sees a token the window
 * split, so no output derives from text past the window, however much redaction shrinks what comes
 * before it. Then redacted, then capped. `null` when the redaction throws or there is no word
 * boundary to cut at (the field is withheld, never sent raw); '' when there is no text.
 *
 * A rule that spans whitespace stays whole too: a private-key block the cut opens runs to the end
 * of the window (its rule matches to the end of the text), and a header or an assignment whose
 * value is past the cut has no value inside the window to leak.
 */
export function wireText(s: string, redact: (t: string) => string = redactForWire): string | null {
  const bounded = wholeWords(s, RAW_MAX)
  if (bounded === null) return null
  const one = stripControls(bounded).replace(/\s+/g, ' ').trim()
  if (one === '') return ''
  const window = wholeWords(one, REDACT_WINDOW)
  if (window === null) return null
  let red: string
  try {
    red = redact(window)
  } catch {
    return null
  }
  return clip(red)
}

/** The text blocks of a row, joined as the legacy reader joins them (`userMessageText`). */
function textOf(content: unknown, sep: string): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b !== null && typeof b === 'object' && (b as { type?: unknown }).type === 'text')
    .map((b) => String((b as { text?: unknown }).text ?? ''))
    .join(sep)
}

function toolUses(content: unknown): number {
  if (!Array.isArray(content)) return 0
  return content.filter(
    (b) => b !== null && typeof b === 'object' && (b as { type?: unknown }).type === 'tool_use'
  ).length
}

// Twins of the legacy reader's helpers (`src/main/claude-reader-derive.ts`): the mod may import
// nothing outside its own folder (MOD-1), and the parity of `firstPrompt` rests on these matching.
// They give the same answers as the reader's regexes, written with `indexOf` so the work stays
// linear (D2): a lazy regex over an unclosed wrapper rescans the rest of the text from every
// opening, quadratic in the text's length.

/** The content of the first `<tag>…</tag>`, or null. Linear: no closing after the first opening
 * means none after any later one either. */
function firstTagged(raw: string, tag: string): string | null {
  const open = `<${tag}>`
  const at = raw.indexOf(open)
  if (at < 0) return null
  const end = raw.indexOf(`</${tag}>`, at + open.length)
  return end < 0 ? null : raw.slice(at + open.length, end)
}

/** Every `<tag>…</tag>` pair replaced by a space, left to right (`/<tag>[\s\S]*?<\/tag>/g`). */
function stripPairs(raw: string, tag: string): string {
  const open = `<${tag}>`
  const close = `</${tag}>`
  let out = ''
  let i = 0
  for (;;) {
    const at = raw.indexOf(open, i)
    if (at < 0) break
    const end = raw.indexOf(close, at + open.length)
    if (end < 0) break
    out += raw.slice(i, at) + ' '
    i = end + close.length
  }
  return out + raw.slice(i)
}

/** `extractCommandName`: the command id out of a `<command-name>` wrapper, or ''. */
export function commandName(raw: string): string {
  return firstTagged(raw, 'command-name')?.trim() ?? ''
}

function commandArgs(raw: string): string {
  return firstTagged(raw, 'command-args')?.trim() ?? ''
}

/**
 * `stripMetaWrappers`: the wrappers Claude Code injects into user turns, removed, in the reader's
 * order; an unclosed `<system-reminder>` (a truncated head scan) drops the rest of the text.
 */
export function stripMetaWrappers(raw: string): string {
  let s = raw
  for (const tag of [
    'system-reminder',
    'command-message',
    'command-name',
    'command-args',
    'local-command-stdout',
    'local-command-caveat'
  ]) {
    s = stripPairs(s, tag)
  }
  const open = s.indexOf('<system-reminder>')
  if (open >= 0) s = s.slice(0, open) + ' '
  return s.replace(/\s+/g, ' ').trim()
}

/** `firstRealPrompt` for one text: a slash command resolves to its name, else the stripped text. */
export function realPrompt(raw: string): string {
  const cmd = commandName(raw)
  if (cmd !== '') return cmd
  return stripMetaWrappers(raw)
}

/**
 * P2W2 §7.7 `stripPluginFrame`: removes "The <name> plugin sent a message:" and the trailing
 * engine paragraph ("… Address the message above."). Returns the input when the anchors do not
 * match. The wording is the engine's and was not observed in W0 (no plugin row in the corpus).
 */
export function stripPluginFrame(text: string): string {
  const head = /^\s*The \S+ plugin sent a message:\s*/.exec(text)
  if (head === null) return text
  let body = text.slice(head[0].length)
  const tail = body.lastIndexOf('\n\n')
  if (tail >= 0 && body.slice(tail).trimEnd().endsWith('Address the message above.'))
    body = body.slice(0, tail)
  return body
}

/**
 * Correction D1 (a verifier, on the W0 findings): a typed prompt whose stored row carries a
 * `<pasted_content …>` wrapper. The CLI's own `last-prompt` holds the content without it, so the
 * tags go and the content stays. No stored row of this shape was found in the local corpus.
 * Linear: a tag with no closing `>` ends the scan (none after it can close either).
 */
export function stripPastedContent(text: string): string {
  let out = ''
  let i = 0
  for (;;) {
    const at = text.indexOf('pasted_content', i)
    if (at < 0) break
    const lt =
      text[at - 1] === '<' ? at - 1 : text[at - 1] === '/' && text[at - 2] === '<' ? at - 2 : -1
    const next = text.charCodeAt(at + 14)
    const boundary = !(
      (next >= 0x30 && next <= 0x39) ||
      (next >= 0x41 && next <= 0x5a) ||
      (next >= 0x61 && next <= 0x7a) ||
      next === 0x5f
    )
    if (lt < 0 || !boundary) {
      out += text.slice(i, at + 14)
      i = at + 14
      continue
    }
    const gt = text.indexOf('>', at + 14)
    if (gt < 0) break
    out += text.slice(i, lt) + ' '
    i = gt + 1
  }
  return out + text.slice(i)
}

// ---- the fold --------------------------------------------------------------------------------

/** The meta wrappers `stripMetaWrappers` removes, in the reader's order. */
const META_TAGS = [
  'system-reminder',
  'command-message',
  'command-name',
  'command-args',
  'local-command-stdout',
  'local-command-caveat'
] as const

/**
 * True when a meta wrapper is still open once every closed pair is gone: in text the raw cap cut,
 * its closing may lie past the cut, and what the reader would strip is still here.
 */
function openWrapper(s: string): boolean {
  let t = s
  for (const tag of META_TAGS) t = stripPairs(t, tag)
  return META_TAGS.some((tag) => t.includes(`<${tag}>`))
}

/**
 * The `firstPrompt` candidate of a main-loop user row (M3b), before the wire pass: '' = no text,
 * `null` = there is one but it cannot be shipped safely or read as the reader reads it (the field
 * is withheld, and the row still counts as the first: the next row is never taken in its place).
 *
 * The command name is looked for in the WHOLE text (one linear scan), so a `<command-name>` past
 * RAW_MAX still names the command as the reader's does. The rest is read from the text cut at
 * RAW_MAX. When that cut leaves a meta wrapper open (its closing lies past the cap), or what it
 * kept is meta-only (the real text lies past the cut), the reader would show text this view does
 * not have, so the first prompt is withheld rather than wrong (F4, G1): `null` is the only value
 * a cut row can take in place of the reader's text, never another row's.
 */
function firstCandidate(r: AppendedRow): string | null {
  const kind = r.origin?.kind
  if (kind === 'peer') return ''
  if (kind === 'plugin' && r.message.isMeta === true) return '' // plugin-meta: not a prompt
  const full = textOf(r.message.content, '')
  // P2W2 §7.7 also skips a `harnu-peer` row (a plugin row opening with the peer envelope); that
  // envelope is P2W3's and not specified yet, so no such row exists to skip.
  const text = kind === 'plugin' && r.origin?.asUser !== true ? stripPluginFrame(full) : full
  const cmd = commandName(text)
  if (cmd !== '') return cmd
  const bounded = wholeWords(text, RAW_MAX)
  if (bounded === null) return null
  const stripped = stripMetaWrappers(bounded)
  // Cut text that reads as meta-only, or leaves a wrapper open, has its real text past the cut:
  // withheld, so the row still counts as the first and the next row's prompt is never taken (G1).
  if (bounded.length < text.length && (stripped === '' || openWrapper(bounded))) return null
  return stripped
}

/**
 * The `lastPrompt` candidate of a main-loop row (M3a), before the wire pass: `undefined` = not a
 * prompt, `null` = a prompt that cannot be shipped safely (withheld).
 *
 * Only origin `composer` was observed (W0 §3.1). Every other origin is skipped: the machine-made
 * ones on purpose (task notifications, `/loop` re-fires, teammate replies, peer messages, local
 * command output), and these by default, UNTESTED because no row of them was ever seen live:
 * `bridge`, `plugin`, `scheduled-trigger`, `sdk`, `slack-ping`, `channel`, `auto-continuation`,
 * `peer-send-message`, `projects-relay`, `observer`. A `claude -p` prompt is one of them (`sdk`), so
 * a headless session reports no last prompt.
 */
function lastCandidate(r: AppendedRow): string | null | undefined {
  if (r.origin?.kind !== 'composer') return undefined
  if (r.door === 'prompt') {
    if (r.message.isMeta === true) return undefined
    const raw = wholeWords(textOf(r.message.content, ''), RAW_MAX)
    return raw === null ? null : stripPastedContent(raw)
  }
  if (r.door === 'command') {
    // the command's name and args, found in the whole text (linear), as for the first prompt
    const full = textOf(r.message.content, '')
    const name = commandName(full)
    if (name === '') return undefined
    const args = commandArgs(full)
    const slash = name.startsWith('/') ? name : `/${name}`
    return args === '' ? slash : `${slash} ${args}`
  }
  return undefined
}

/**
 * Folds one stored row in. `at` is the mod clock's time of the append. Returns whether a field a
 * push carries changed for a reason worth a push: a row that only moves `lastRowAt` / `lastUuid`
 * (an attachment, a notice) is not one, and rides the next push instead (spec §5.4). A row whose
 * uuid was folded already is dropped whole (the engine is not known to repeat one; this keeps a
 * repeat from counting twice, D6).
 */
export function foldAppend(
  fold: Fold,
  r: AppendedRow,
  at: number,
  redact: (t: string) => string = redactForWire
): boolean {
  if (!FOLDED.has(r.door)) return false // not hooked, or a door this fold does not know
  const row = fold.row
  const m = r.message
  const uuid =
    typeof r.uuid === 'string' && r.uuid !== '' && r.uuid.length <= UUID_MAX ? r.uuid : null
  if (uuid !== null) {
    if (fold.recent.includes(uuid)) return false
    fold.recent.push(uuid)
    if (fold.recent.length > RECENT_UUIDS) fold.recent.shift()
  }
  if (r.agentId !== undefined) {
    // A subagent's row: its tool calls are counted apart, nothing else moves. Its rows live in
    // another file, so neither `lastUuid` nor `lastRowAt` follows them.
    if (m.type !== 'assistant') return false
    const n = toolUses(m.content)
    row.subagentToolCalls += n
    return n > 0
  }
  if (r.door !== 'hook-context') {
    if (uuid !== null) row.lastUuid = uuid
    row.lastRowAt = at
  }
  let changed = false
  if (m.type === 'user') {
    row.userRows++
    changed = true
    if (!fold.firstTaken) {
      const t = firstCandidate(r)
      if (t === null) {
        fold.firstTaken = true
        row.firstPrompt = null
      } else if (t !== '') {
        fold.firstTaken = true
        row.firstPrompt = wireText(t, redact)
      }
    }
    const last = lastCandidate(r)
    if (last !== undefined) {
      const t = last === null ? null : wireText(last, redact)
      if (t !== '') row.lastPrompt = t
    }
  }
  if (r.door === 'response' && m.type === 'assistant') {
    const n = toolUses(m.content)
    if (n > 0) {
      row.toolCalls += n
      changed = true
    }
    const t = wireText(textOf(m.content, ' '), redact)
    if (t !== '') {
      row.lastAssistant = t
      changed = true
    }
  }
  return changed
}

/** The latest `session_title` (M2: a custom title only). Absent or empty changes nothing. */
export function foldTitle(
  fold: Fold,
  title: unknown,
  redact: (t: string) => string = redactForWire
): boolean {
  if (typeof title !== 'string') return false
  const t = wireText(title, redact)
  if (t === '' || t === fold.row.title) return false
  fold.row.title = t
  return true
}
