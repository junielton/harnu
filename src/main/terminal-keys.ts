/**
 * Terminal keys, pure (T474 unit B5, spec §4.4): turns what an agent asked `send_terminal` to
 * type into the bytes one send writes to the PTY.
 *
 * Three jobs:
 *  - **keys** — the named keys an agent may press (`Enter`, `Esc`, `Ctrl+C`, arrows, `F1`–`F12`
 *    …) and the bytes each one is. Arrows (and `Home`/`End`) follow the program's cursor-key
 *    mode: `\x1b[A` normally, `\x1bOA` once the program turned application cursor keys on.
 *  - **input** — the text a person would type. `\n` is sent as `\r` (what Enter produces in raw
 *    mode), `\t` stays a tab, and every other control character is refused so each control action
 *    is a NAMED key and the audit describes exactly what happened. A single line is capped at
 *    4,000 bytes: a Linux tty in canonical mode cuts a line at 4,095, so a longer one would be
 *    silently truncated by the kernel.
 *  - **segments** — the `Esc` exception to "one send is one write": an `Esc` immediately followed
 *    by more bytes is read by programs as Meta+key, so the send is cut after it and the caller
 *    pauses {@link ESC_GAP_MS} between the pieces.
 *
 * Also the audit summary of a send (spec §6.5): terminal id, owner, the typed input escaped,
 * scrubbed and cut to 200 chars, the key list and the gate path.
 *
 * Pure (ADR-0001): no electron, no fs, no clock.
 */
import { scrubTerminalText } from './scrub-terminal'

/** `input` budget for one send, in bytes (spec §4.4). */
export const MAX_INPUT_BYTES = 8 * 1024
/** Longest single line of `input`, in bytes (spec §4.4, R15). */
export const MAX_LINE_BYTES = 4000
/** Most keys one send may press (spec §4.4). */
export const MAX_KEYS = 64
/** Pause between an `Esc` and the bytes that follow it in the same send (spec §4.4). */
export const ESC_GAP_MS = 50
/** The audit line keeps this much of the typed input (spec §6.5). */
export const AUDIT_INPUT_MAX_CHARS = 200

/** Bracketed-paste markers (`DECSET 2004`). */
export const PASTE_START = '\x1b[200~'
export const PASTE_END = '\x1b[201~'

const ESC = '\x1b'

/** The program's input modes, read from the screen model at send time. */
export interface KeyModes {
  /** `DECCKM`: arrows send `ESC O A` instead of `ESC [ A`. */
  applicationCursorKeys: boolean
  /** `DECSET 2004`: the program asked for bracketed paste. */
  bracketedPaste: boolean
}

/** Keys whose bytes never change. */
const FIXED_KEYS: Readonly<Record<string, string>> = {
  Enter: '\r',
  Tab: '\t',
  Esc: ESC,
  Backspace: '\x7f',
  Delete: `${ESC}[3~`,
  Space: ' ',
  PageUp: `${ESC}[5~`,
  PageDown: `${ESC}[6~`,
  F1: `${ESC}OP`,
  F2: `${ESC}OQ`,
  F3: `${ESC}OR`,
  F4: `${ESC}OS`,
  F5: `${ESC}[15~`,
  F6: `${ESC}[17~`,
  F7: `${ESC}[18~`,
  F8: `${ESC}[19~`,
  F9: `${ESC}[20~`,
  F10: `${ESC}[21~`,
  F11: `${ESC}[23~`,
  F12: `${ESC}[24~`
}

/** The final byte of the keys that switch with the cursor-key mode. */
const CURSOR_KEYS: Readonly<Record<string, string>> = {
  Up: 'A',
  Down: 'B',
  Right: 'C',
  Left: 'D',
  Home: 'H',
  End: 'F'
}

const CTRL_RE = /^Ctrl\+([A-Z])$/

/** Every key name an agent may use, for the error that steers it. */
export const KEY_NAMES: readonly string[] = [
  ...Object.keys(FIXED_KEYS).filter((k) => !/^F\d+$/.test(k)),
  ...Object.keys(CURSOR_KEYS),
  'F1–F12',
  'Ctrl+A–Ctrl+Z'
]

/** Whether `key` is a key name {@link keyBytes} knows. Independent of the cursor-key mode. */
export function isKnownKey(key: string): boolean {
  return Object.hasOwn(FIXED_KEYS, key) || Object.hasOwn(CURSOR_KEYS, key) || CTRL_RE.test(key)
}

/** The bytes of one named key, or `null` for a name that is not a key (`KEY_UNKNOWN`). */
export function keyBytes(
  key: string,
  modes: Pick<KeyModes, 'applicationCursorKeys'>
): string | null {
  const fixed = Object.hasOwn(FIXED_KEYS, key) ? FIXED_KEYS[key] : undefined
  if (fixed !== undefined) return fixed
  const final = Object.hasOwn(CURSOR_KEYS, key) ? CURSOR_KEYS[key] : undefined
  if (final !== undefined) return `${ESC}${modes.applicationCursorKeys ? 'O' : '['}${final}`
  const ctrl = CTRL_RE.exec(key)
  if (ctrl) return String.fromCharCode(ctrl[1]!.charCodeAt(0) - 64)
  return null
}

/** Why a send was refused before any byte was built. */
export type SendInputError = 'BAD_ARGS' | 'INPUT_TOO_LARGE' | 'KEY_UNKNOWN'

export interface SendInputFailure {
  error: SendInputError
  /** One line the agent can act on. */
  detail: string
}

/**
 * First control character in `text` that `input` may not carry, as a printable label; `null`
 * when there is none. C0 other than `\n` and `\t` is refused (spec §4.4); so are DEL and the C1
 * range, which a terminal in 8-bit mode reads as a control just the same.
 */
function firstForbiddenControl(text: string): string | null {
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    const isC0 = c < 0x20 && c !== 0x0a && c !== 0x09
    if (isC0 || c === 0x7f || (c >= 0x80 && c <= 0x9f)) {
      return c === 0x0d ? '\\r' : `\\x${c.toString(16).padStart(2, '0')}`
    }
  }
  return null
}

/** Longest key name the verb accepts (`PageDown`, `Ctrl+A` … are well under it). */
export const MAX_KEY_NAME_CHARS = 16

/**
 * An agent-supplied key name, made safe to echo back and to audit: control characters shown, cut
 * to {@link MAX_KEY_NAME_CHARS}, in quotes. The name is untrusted text and lands in an error that
 * is rendered in a terminal and written to the audit log.
 */
function quoteKey(key: string): string {
  const chars = [...key]
  const cut = chars.length > MAX_KEY_NAME_CHARS
  const shown = escapeForAudit(chars.slice(0, MAX_KEY_NAME_CHARS).join(''), true)
  return `"${shown}${cut ? '…' : ''}"`
}

/**
 * Check the CONTENT of a send, with no terminal state needed: control characters, size and key
 * names. Runs at plan level so a bad call is refused before any confirm.
 */
export function checkSendContent(input: {
  input?: string | undefined
  keys?: readonly string[] | undefined
}): SendInputFailure | null {
  const text = input.input
  if (text !== undefined) {
    const bad = firstForbiddenControl(text)
    if (bad !== null) {
      return {
        error: 'BAD_ARGS',
        detail: `input contains the control character ${bad}. Use \`keys\` for Enter, Tab, Esc, Ctrl+C and the like; input is typed text, and a newline is written \\n.`
      }
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_INPUT_BYTES) {
      return {
        error: 'INPUT_TOO_LARGE',
        detail: `input is longer than ${MAX_INPUT_BYTES} bytes. Send it in smaller pieces.`
      }
    }
    for (const line of text.split('\n')) {
      if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
        return {
          error: 'INPUT_TOO_LARGE',
          detail: `a line of input is longer than ${MAX_LINE_BYTES} bytes; the terminal would cut it silently. Split it, or write it to a file and run that.`
        }
      }
    }
  }
  for (const key of input.keys ?? []) {
    if (!isKnownKey(key)) {
      return {
        error: 'KEY_UNKNOWN',
        detail: `${quoteKey(key)} is not a key. Use one of: ${KEY_NAMES.join(', ')}.`
      }
    }
  }
  return null
}

/** What one send writes, cut into the pieces that go out as separate `pty.write`s. */
export interface BuiltSend {
  /** Pieces to write in order, {@link ESC_GAP_MS} apart. Almost always exactly one. */
  segments: string[]
  /** What each segment carries, parallel to {@link segments}: whether `input`, and how many keys. */
  parts: { input: boolean; keys: number }[]
  /** `paste: true` was honoured: the program has bracketed paste on. */
  pasted: boolean
}

/**
 * The bytes of one send: `input` typed (or pasted), then `keys` pressed in order. Throws nothing:
 * the content is assumed to have passed {@link checkSendContent}; a key that did not is returned
 * as a failure all the same, so a caller that skipped the check still cannot write garbage.
 */
export function buildSend(
  args: { input?: string | undefined; keys?: readonly string[] | undefined; paste?: boolean },
  modes: KeyModes
): ({ ok: true } & BuiltSend) | ({ ok: false } & SendInputFailure) {
  const bad = checkSendContent(args)
  if (bad) return { ok: false, ...bad }

  // Tokens, so the Esc split lands on a key boundary and never inside an escape sequence.
  const tokens: { bytes: string; esc: boolean; input: boolean }[] = []
  let pasted = false
  if (args.input !== undefined && args.input.length > 0) {
    // `\n` is what Enter produces in raw mode.
    const typed = args.input.replace(/\n/g, '\r')
    pasted = args.paste === true && modes.bracketedPaste
    tokens.push({
      bytes: pasted ? `${PASTE_START}${typed}${PASTE_END}` : typed,
      esc: false,
      input: true
    })
  }
  for (const key of args.keys ?? []) {
    const bytes = keyBytes(key, modes)
    if (bytes === null) {
      return { ok: false, error: 'KEY_UNKNOWN', detail: `${quoteKey(key)} is not a key.` }
    }
    tokens.push({ bytes, esc: key === 'Esc', input: false })
  }

  const segments: string[] = []
  const parts: { input: boolean; keys: number }[] = []
  let current = ''
  let part = { input: false, keys: 0 }
  tokens.forEach((t, i) => {
    current += t.bytes
    if (t.input) part.input = true
    else part.keys++
    // An Esc followed by more bytes in the same send is cut off from them (spec §4.4).
    if (t.esc && i < tokens.length - 1) {
      segments.push(current)
      parts.push(part)
      current = ''
      part = { input: false, keys: 0 }
    }
  })
  if (current.length > 0) {
    segments.push(current)
    parts.push(part)
  }
  return { ok: true, segments, parts, pasted }
}

/**
 * Characters that draw nothing or reorder what is drawn around them: bidi controls (an RLO makes
 * `evil` read as `live`), zero-width characters, line and paragraph separators, the BOM, soft
 * hyphen and the invisible tag block. In an audit line or a confirm prompt they would let typed
 * text look like something else, so they are shown as `\\u{hex}`.
 */
function isInvisibleFormat(c: number): boolean {
  return (
    c === 0x00ad ||
    c === 0x061c ||
    c === 0x180e ||
    (c >= 0x200b && c <= 0x200f) ||
    (c >= 0x2028 && c <= 0x202e) ||
    (c >= 0x2060 && c <= 0x2064) ||
    (c >= 0x2066 && c <= 0x2069) ||
    c === 0xfeff ||
    (c >= 0xfff9 && c <= 0xfffb) ||
    (c >= 0xe0000 && c <= 0xe007f)
  )
}

/**
 * `text` with every control character made visible, so an audit line shows what was typed. The
 * double quote is escaped too (the input sits between quotes: an unescaped one would end the field
 * early and let typed text forge the fields after it), and so are the invisible and reordering
 * characters of {@link isInvisibleFormat}. `strict` also escapes what separates fields (space, `=`,
 * `,`, brackets), for values that sit bare in the line. It never cuts: the audit line cuts the
 * input in {@link summarizeSend}, and a confirm prompt shows all of it.
 */
export function escapeForAudit(text: string, strict = false): string {
  let out = ''
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\t') out += '\\t'
    else if (ch === '\\') out += '\\\\'
    else if (ch === '"') out += '\\"'
    else if (strict && ' =,[]'.includes(ch)) out += `\\x${c.toString(16).padStart(2, '0')}`
    else if (isInvisibleFormat(c)) out += `\\u{${c.toString(16)}}`
    else if (c < 0x20 || c === 0x7f || (c >= 0x80 && c <= 0x9f)) {
      out += `\\x${c.toString(16).padStart(2, '0')}`
    } else out += ch
  }
  return out
}

/** Longest owner / terminal id the audit line carries; the rest is cut. */
const AUDIT_FIELD_MAX_CHARS = 80

/** A bare field value of the audit line: escaped strictly and bounded. */
export function auditField(value: string): string {
  const chars = [...value]
  const cut = chars.length > AUDIT_FIELD_MAX_CHARS
  return escapeForAudit(chars.slice(0, AUDIT_FIELD_MAX_CHARS).join(''), true) + (cut ? '…' : '')
}

/** How a send was authorised (spec §6.5). The lease and the confirm join in unit B6. */
export type SendGatePath = 'free' | 'lease' | 'confirmed' | 'confirm'

/**
 * The audit summary of one `send_terminal` call (spec §6.5): terminal id, owner, the input
 * scrubbed, escaped and cut to {@link AUDIT_INPUT_MAX_CHARS}, the key list and the gate path.
 * The scrub runs first and over the whole input, so the cut can never leave half a secret.
 */
export function summarizeSend(args: {
  terminalId: string
  owner: string | null
  input?: string | undefined
  keys?: readonly string[] | undefined
  gate: SendGatePath
  home: string
}): string {
  const typed = args.input ?? ''
  const scrubbed = typed === '' ? '' : scrubTerminalText(typed, args.home)
  let escaped = escapeForAudit(scrubbed)
  if (escaped.length > AUDIT_INPUT_MAX_CHARS) {
    escaped = `${escaped.slice(0, AUDIT_INPUT_MAX_CHARS)}…`
  }
  const keys = (args.keys ?? []).map((k) => auditField(k)).join(',')
  return (
    `send_terminal terminal=${auditField(args.terminalId)} owner=${args.owner === null ? '-' : auditField(args.owner)} ` +
    `input="${escaped}" keys=[${keys}] gate=${args.gate}`
  )
}
