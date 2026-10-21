/**
 * The frame every `context.append` row travels in (T389 P2W4 §7.1, T257 §6.4). Pure.
 *
 * A context row is a hidden user-role message the model reads as instructions-adjacent text, so
 * the host builds it from a closed registry and never takes text from a caller. This file is the
 * shared half: one `frameContext` that wraps trusted prose, a few labelled fields and an optional
 * quoted block, and that makes the untrusted parts (a path, a line of somebody's code) unable to
 * close the frame, open a second one or forge another key. P2W4's orchestrator and mission rows
 * use the same function.
 */

import type { ContextKey } from './contract'

export const FRAME_TAG = 'harnu-context'

/**
 * C0 controls except tab, DEL, C1, and the Unicode line and paragraph separators (U+2028, U+2029).
 * The ESC that starts a terminal sequence is in the range, and so is the newline: a field or a
 * quoted line is exactly one line, to a reader that breaks lines on the separators too.
 */
export const CONTROL_PATTERN = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029]/ // eslint-disable-line no-control-regex
const CONTROL_RE = new RegExp(CONTROL_PATTERN.source, 'g')

export const stripControl = (s: string): string => s.replace(CONTROL_RE, '')

/**
 * `</harnu-context` becomes `<\/harnu-context` and `<harnu-context` becomes `<\harnu-context`, with
 * any whitespace a loose reader might forgive inside the tag also caught. A quoted line cannot end
 * the frame, start a second one or restate a `key`, because none of those survives as a tag.
 */
export const escapeFrame = (s: string): string =>
  s.replace(new RegExp(`<\\s*(/?)\\s*${FRAME_TAG}`, 'gi'), `<\\$1${FRAME_TAG}`)

/** What an untrusted fragment goes through before it is placed in a frame. */
export const sanitizeFragment = (s: string): string => escapeFrame(stripControl(s))

export interface FrameInput {
  key: ContextKey
  /** The wording revision of the frame, so a reader can tell two layouts apart. */
  rev: string
  state: 'active'
  /** Trusted prose, written by Harnu. Never contains caller text. */
  preamble: readonly string[]
  /** `label: value` lines. Values are untrusted and are sanitised here. */
  fields: readonly string[]
  /** An untrusted block, one entry per line, already gutter-prefixed by the caller. */
  quoted?: readonly string[]
  /** One trusted sentence in place of the block (the cap notice, a mixed-side note). */
  note?: string
}

/**
 * The fence is a fixed three backticks. A quoted line always starts with a space and a number (the
 * caller's gutter), so no line of the block can be a fence of its own; the sanitising above is the
 * second lock, not the only one.
 */
export function frameContext(input: FrameInput): string {
  const out: string[] = [
    `<${FRAME_TAG} key="${input.key}" rev="${input.rev}" state="${input.state}">`,
    ...input.preamble,
    ...input.fields.map(sanitizeFragment)
  ]
  if (input.note !== undefined) out.push(input.note)
  if (input.quoted !== undefined) {
    out.push('```quoted', ...input.quoted.map(sanitizeFragment), '```')
  }
  out.push(`</${FRAME_TAG}>`)
  return out.join('\n')
}
