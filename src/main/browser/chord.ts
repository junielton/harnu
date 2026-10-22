/**
 * Chord forwarding from a focused guest (T564 U1, spec §2.5). A focused guest swallows keystrokes before the
 * renderer's keybinding engine sees them, so main installs `before-input-event` on every guest and decides
 * synchronously whether Harnu or the page owns a key.
 *
 * Rules, all measured in U0 (A8): run only on `keyDown`; never while `input.isComposing` or for
 * `key === 'Process'` / keyCode 229 (IME); ignore bare modifier presses; a chord that is
 * `preventDefault`ed reaches neither the page's `keydown` nor its `keyup`. The page keeps a short page-owns
 * list (copy, paste, cut, select-all, undo, redo, find). Pure: no electron.
 */

/** The subset of Electron's `Input` this module reads. */
export interface GuestInput {
  type: string
  key: string
  code?: string
  control: boolean
  alt: boolean
  shift: boolean
  meta: boolean
  isComposing?: boolean
  isAutoRepeat?: boolean
}

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'OS', 'Super'])

/** Chords the page always keeps (spec §2.5): copy, paste, cut, select-all, undo/redo, find. */
const PAGE_OWNS = new Set([
  'Cmd+C',
  'Cmd+V',
  'Cmd+X',
  'Cmd+A',
  'Cmd+Z',
  'Cmd+Shift+Z',
  'Cmd+Y',
  'Cmd+F',
  'Cmd+G'
])

/** A bare modifier press (`Control`, `Shift`, …) is never a chord of its own. */
export function isBareModifier(key: string): boolean {
  return MODIFIER_KEYS.has(key)
}

/** `Cmd` is Control off macOS and Meta on it, exactly the fold the keybindings table uses. */
function primary(input: GuestInput, mac: boolean): { cmd: boolean; ctrl: boolean } {
  return mac ? { cmd: input.meta, ctrl: input.control } : { cmd: input.control, ctrl: false }
}

function normalizeKey(key: string): string {
  if (key.length === 1) return key.toUpperCase()
  const arrows: Record<string, string> = {
    ArrowUp: 'ArrowUp',
    ArrowDown: 'ArrowDown',
    ArrowLeft: 'ArrowLeft',
    ArrowRight: 'ArrowRight'
  }
  return arrows[key] ?? key
}

/**
 * The canonical chord of a key event in the keybindings grammar (`Cmd+Shift+C`, `F5`), or `null` when it is
 * not a chord: a bare modifier, or a plain key with no Cmd/Ctrl/Alt and not a function key.
 */
export function chordOf(input: GuestInput, mac: boolean): string | null {
  if (isBareModifier(input.key)) return null
  const { cmd, ctrl } = primary(input, mac)
  const isFunctionKey = /^F([1-9]|1[0-9]|2[0-4])$/.test(input.key)
  if (!cmd && !ctrl && !input.alt && !isFunctionKey) return null
  const parts: string[] = []
  if (cmd) parts.push('Cmd')
  if (ctrl) parts.push('Ctrl')
  if (input.alt) parts.push('Alt')
  if (input.shift) parts.push('Shift')
  // `Ctrl +` is Shift and `=` on most layouts: fold it onto the `=` chord the zoom binding uses (T572).
  if (input.key === '+') {
    const at = parts.indexOf('Shift')
    if (at !== -1) parts.splice(at, 1)
    parts.push('=')
  } else parts.push(normalizeKey(input.key))
  return parts.join('+')
}

export interface ForwardDecision {
  /** True when main must `preventDefault` the key and hand the chord to the renderer. */
  forward: boolean
  chord: string | null
}

/**
 * Whether a guest key event is a Harnu chord. `boundChords` is the set of canonical chords the renderer
 * currently binds in the `global` and `browser` scopes (it pushes the set whenever bindings change), so a
 * key Harnu does not bind always reaches the page untouched.
 */
export function decideForward(
  input: GuestInput,
  boundChords: ReadonlySet<string>,
  mac: boolean
): ForwardDecision {
  const none: ForwardDecision = { forward: false, chord: null }
  if (input.type !== 'keyDown') return none
  if (input.isComposing === true || input.key === 'Process') return none
  const chord = chordOf(input, mac)
  if (chord === null) return none
  if (PAGE_OWNS.has(chord)) return { forward: false, chord }
  return { forward: boundChords.has(chord), chord }
}
