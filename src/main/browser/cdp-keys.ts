/**
 * Key chords for `browser_press` as CDP `Input.dispatchKeyEvent` parameters (T564 U4, spec §6.2): the
 * `send_terminal` key vocabulary (`Enter`, `Tab`, `Esc`, `Backspace`, `Delete`, `Space`, arrows, `Home`, `End`,
 * `PageUp`, `PageDown`, `F1`–`F12`, `Ctrl+A`…) plus `Meta+` / `Alt+` / `Shift+` modifiers. Pure (ADR-0001).
 */

/** The most keys one `browser_press` takes. */
export const MAX_PRESS_KEYS = 64

/** The longest chord string accepted before it is judged. */
export const MAX_CHORD_CHARS = 32

/** Modifier bit masks of `Input.dispatchKeyEvent.modifiers`. */
export const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const

export interface CdpKeyDef {
  key: string
  code: string
  windowsVirtualKeyCode: number
  /** The character inserted, when the key (with these modifiers) types one. */
  text?: string
}

export interface ParsedChord {
  modifiers: number
  def: CdpKeyDef
}

const NAMED: Readonly<Record<string, CdpKeyDef>> = {
  Enter: { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
  Esc: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 },
  Space: { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' },
  Up: { key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 },
  Down: { key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 },
  Left: { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 },
  Right: { key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 },
  Home: { key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', windowsVirtualKeyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', windowsVirtualKeyCode: 34 }
}

/** The names an agent may use, for the error that steers it. */
export const PRESS_KEY_NAMES: readonly string[] = [
  ...Object.keys(NAMED),
  'F1–F12',
  'a single letter, digit or symbol',
  'with Ctrl+, Alt+, Meta+ or Shift+ in front'
]

const MODIFIER_NAMES: Readonly<Record<string, number>> = {
  Ctrl: MOD.ctrl,
  Control: MOD.ctrl,
  Alt: MOD.alt,
  Option: MOD.alt,
  Meta: MOD.meta,
  Cmd: MOD.meta,
  Shift: MOD.shift
}

/** US-layout punctuation: character → [shifted?, code, vk]. */
const PUNCT: Readonly<Record<string, readonly [boolean, string, number]>> = {
  '-': [false, 'Minus', 189],
  '=': [false, 'Equal', 187],
  '[': [false, 'BracketLeft', 219],
  ']': [false, 'BracketRight', 221],
  '\\': [false, 'Backslash', 220],
  ';': [false, 'Semicolon', 186],
  "'": [false, 'Quote', 222],
  ',': [false, 'Comma', 188],
  '.': [false, 'Period', 190],
  '/': [false, 'Slash', 191],
  '`': [false, 'Backquote', 192]
}

function baseDef(base: string, shift: boolean): CdpKeyDef | null {
  if (Object.hasOwn(NAMED, base)) return NAMED[base]!
  const f = /^F([1-9]|1[0-2])$/.exec(base)
  if (f) {
    const n = Number(f[1])
    return { key: base, code: base, windowsVirtualKeyCode: 111 + n }
  }
  if (base.length === 1) {
    if (/^[a-zA-Z]$/.test(base)) {
      const upper = base.toUpperCase()
      return {
        key: shift ? upper : base.toLowerCase(),
        code: `Key${upper}`,
        windowsVirtualKeyCode: upper.charCodeAt(0),
        text: shift ? upper : base.toLowerCase()
      }
    }
    if (/^[0-9]$/.test(base)) {
      return {
        key: base,
        code: `Digit${base}`,
        windowsVirtualKeyCode: base.charCodeAt(0),
        text: base
      }
    }
    const p = PUNCT[base]
    if (p) return { key: base, code: p[1], windowsVirtualKeyCode: p[2], text: base }
  }
  return null
}

/**
 * Parse one chord (`Enter`, `Ctrl+A`, `Meta+K`, `Shift+Tab`, `Alt+F4`, `a`) or `null` for a name that is not a key.
 * The `text` is dropped when Ctrl, Alt or Meta is held, so a shortcut never also types its letter.
 */
export function parseChord(raw: string): ParsedChord | null {
  if (raw.length === 0 || [...raw].length > MAX_CHORD_CHARS) return null
  // The last `+` is a separator unless the chord ENDS in `+` itself (the `+` key: `Shift+`+`+`).
  const parts: string[] = []
  let rest = raw
  for (;;) {
    const at = rest.indexOf('+')
    if (at <= 0 || at === rest.length - 1) break
    parts.push(rest.slice(0, at))
    rest = rest.slice(at + 1)
  }
  const base = rest
  let modifiers = 0
  for (const p of parts) {
    const bit = MODIFIER_NAMES[p]
    if (bit === undefined || (modifiers & bit) !== 0) return null
    modifiers |= bit
  }
  const def = baseDef(base, (modifiers & MOD.shift) !== 0)
  if (!def) return null
  const types = (modifiers & (MOD.ctrl | MOD.alt | MOD.meta)) === 0
  const { text, ...noText } = def
  return { modifiers, def: types && text !== undefined ? def : noText }
}

/** A key that no chord names, with the offending name quoted and cut (it is untrusted text). */
export function firstUnknownKey(keys: readonly string[]): string | null {
  for (const k of keys) if (parseChord(k) === null) return k
  return null
}

export interface CdpKeyEvent {
  type: 'keyDown' | 'rawKeyDown' | 'keyUp'
  modifiers: number
  key: string
  code: string
  windowsVirtualKeyCode: number
  text?: string
}

/** The `Input.dispatchKeyEvent` calls of one chord, in order: key down, then key up. */
export function chordEvents(chord: ParsedChord): CdpKeyEvent[] {
  const { def, modifiers } = chord
  const base = {
    modifiers,
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.windowsVirtualKeyCode
  }
  return [
    // A key that types a character is a `keyDown` carrying `text`; the rest are `rawKeyDown`.
    def.text !== undefined
      ? { type: 'keyDown', ...base, text: def.text }
      : { type: 'rawKeyDown', ...base },
    { type: 'keyUp', ...base }
  ]
}
