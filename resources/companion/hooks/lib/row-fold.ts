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
/** Every text field's cap, after whitespace is collapsed (spec §5.3). */
export const TEXT_MAX = 240
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

/** The fold: the row, and whether the first prompt was already taken (even if withheld). */
export interface Fold {
  row: Row
  firstTaken: boolean
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
  firstTaken: false
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
  firstTaken: true
})

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
    lastUuid: typeof uuid === 'string' && uuid.length <= 128 ? uuid : null
  }
}

// ---- text ------------------------------------------------------------------------------------

/** Collapses whitespace and cuts at TEXT_MAX, never inside a surrogate pair. */
export function clip(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim()
  if (one.length <= TEXT_MAX) return one
  let end = TEXT_MAX - 1
  const c = one.charCodeAt(end - 1)
  if (c >= 0xd800 && c <= 0xdbff) end--
  return one.slice(0, end) + '…'
}

/**
 * A text for the wire: collapsed, redacted inside REDACT_WINDOW, then capped. `null` when the
 * redaction throws (the field is withheld, never sent raw); '' when there is no text.
 */
export function wireText(s: string, redact: (t: string) => string = redactForWire): string | null {
  const one = s.replace(/\s+/g, ' ').trim()
  if (one === '') return ''
  let red: string
  try {
    red = redact(one.slice(0, REDACT_WINDOW))
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

/** `extractCommandName`: the command id out of a `<command-name>` wrapper, or ''. */
export function commandName(raw: string): string {
  const m = raw.match(/<command-name>([\s\S]*?)<\/command-name>/)
  return m?.[1]?.trim() ?? ''
}

function commandArgs(raw: string): string {
  const m = raw.match(/<command-args>([\s\S]*?)<\/command-args>/)
  return m?.[1]?.trim() ?? ''
}

/**
 * `stripMetaWrappers`: the wrappers Claude Code injects into user turns, removed. End of input is
 * spelled `(?![\s\S])` in this file: MOD-1's source scan reads a bare `$` as the engine interface.
 */
export function stripMetaWrappers(raw: string): string {
  return raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, ' ')
    .replace(/<command-name>[\s\S]*?<\/command-name>/g, ' ')
    .replace(/<command-args>[\s\S]*?<\/command-args>/g, ' ')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, ' ')
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, ' ')
    .replace(/<system-reminder>[\s\S]*(?![\s\S])/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
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
  if (tail >= 0 && /Address the message above\.\s*(?![\s\S])/.test(body.slice(tail)))
    body = body.slice(0, tail)
  return body
}

/**
 * Correction D1 (a verifier, on the W0 findings): a typed prompt whose stored row carries a
 * `<pasted_content …>` wrapper. The CLI's own `last-prompt` holds the content without it, so the
 * tags go and the content stays. No stored row of this shape was found in the local corpus.
 */
export function stripPastedContent(text: string): string {
  return text.replace(/<\/?pasted_content\b[^>]*>/g, ' ')
}

// ---- the fold --------------------------------------------------------------------------------

/** The `firstPrompt` candidate of a main-loop user row (M3b), before the wire pass; '' = none. */
function firstCandidate(r: AppendedRow): string {
  const kind = r.origin?.kind
  if (kind === 'peer') return ''
  const raw = textOf(r.message.content, '')
  if (kind === 'plugin') {
    if (r.message.isMeta === true) return '' // plugin-meta: context for the model, not a prompt
    // P2W2 §7.7 also skips a `harnu-peer` row (a plugin row opening with the peer envelope); that
    // envelope is P2W3's and not specified yet, so no such row exists to skip.
    return realPrompt(r.origin?.asUser === true ? raw : stripPluginFrame(raw))
  }
  return realPrompt(raw)
}

/**
 * The `lastPrompt` candidate of a main-loop row (M3a), before the wire pass; null = not a prompt.
 *
 * Only origin `composer` was observed (W0 §3.1). Every other origin is skipped: the machine-made
 * ones on purpose (task notifications, `/loop` re-fires, teammate replies, peer messages, local
 * command output), and these by default, UNTESTED because no row of them was ever seen: `bridge`,
 * `plugin`, `scheduled-trigger`, `sdk`, `slack-ping`, `channel`, `auto-continuation`,
 * `peer-send-message`, `projects-relay`, `observer`.
 */
function lastCandidate(r: AppendedRow): string | null {
  if (r.origin?.kind !== 'composer') return null
  const raw = textOf(r.message.content, '')
  if (r.door === 'prompt') {
    if (r.message.isMeta === true) return null
    return stripPastedContent(raw)
  }
  if (r.door === 'command') {
    const name = commandName(raw)
    if (name === '') return null
    const args = commandArgs(raw)
    const slash = name.startsWith('/') ? name : `/${name}`
    return args === '' ? slash : `${slash} ${args}`
  }
  return null
}

/**
 * Folds one stored row in. `at` is the mod clock's time of the append. Returns whether a field a
 * push carries changed for a reason worth a push: a row that only moves `lastRowAt` / `lastUuid`
 * (an attachment, a notice) is not one, and rides the next push instead (spec §5.4).
 */
export function foldAppend(
  fold: Fold,
  r: AppendedRow,
  at: number,
  redact: (t: string) => string = redactForWire
): boolean {
  const row = fold.row
  const m = r.message
  if (r.agentId !== undefined) {
    // A subagent's row: its tool calls are counted apart, nothing else moves. Its rows live in
    // another file, so neither `lastUuid` nor `lastRowAt` follows them.
    if (m.type !== 'assistant') return false
    const n = toolUses(m.content)
    row.subagentToolCalls += n
    return n > 0
  }
  if (r.door !== 'hook-context') {
    if (typeof r.uuid === 'string' && r.uuid !== '') row.lastUuid = r.uuid
    row.lastRowAt = at
  }
  let changed = false
  if (m.type === 'user') {
    row.userRows++
    changed = true
    if (!fold.firstTaken) {
      const t = firstCandidate(r)
      if (t !== '') {
        fold.firstTaken = true
        row.firstPrompt = wireText(t, redact)
      }
    }
    const last = lastCandidate(r)
    if (last !== null) {
      const t = wireText(last, redact)
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
