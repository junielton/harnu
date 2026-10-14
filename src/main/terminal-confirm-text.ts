/**
 * What the operator sees in a `send_terminal` confirm (T484 F4, spec §6.3): the agent's text made
 * safe to read. The confirm is the only thing standing between an agent and the operator's shell,
 * so it must not be possible to make it say something other than what would be typed.
 *
 * Pure (ADR-0001): no electron, no fs.
 */
import { escapeForAudit } from './terminal-keys'

/**
 * Characters that change how text is laid out or hidden without showing a glyph: bidi controls
 * (U+202A–E, U+2066–9, U+200E/F, U+061C), zero-width and joiner characters, line and paragraph
 * separators, the BOM, invisible operators, tag characters, and the non-ASCII spaces that can
 * pad a line so the real command is pushed out of sight.
 */
const INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00a0, 0x00a0],
  [0x00ad, 0x00ad],
  [0x061c, 0x061c],
  [0x1680, 0x1680],
  [0x180e, 0x180e],
  [0x2000, 0x200f],
  [0x2028, 0x202f],
  [0x205f, 0x206f],
  [0x3000, 0x3000],
  [0xfeff, 0xfeff],
  [0xfff9, 0xfffb],
  [0xe0000, 0xe007f]
]

const isInvisible = (cp: number): boolean =>
  INVISIBLE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi)

/**
 * `text` as the confirm shows it, in FULL: C0/C1 controls and backslashes as `\x..`/`\n`/`\\`
 * (the audit escaper), then every invisible or direction-changing character as `\u{…}`.
 * Nothing is cut: the 200-character limit belongs to the audit summary only.
 */
export function escapeForConfirm(text: string): string {
  let out = ''
  for (const ch of escapeForAudit(text)) {
    const cp = ch.codePointAt(0)!
    out += isInvisible(cp) ? `\\u{${cp.toString(16)}}` : ch
  }
  return out
}

/** The leading part of a pane id (`h-<uuid>`), enough to tell two panes in one folder apart. */
export function shortPaneId(terminalId: string): string {
  return terminalId.slice(0, 10)
}
