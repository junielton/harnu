/**
 * keybindings-core.ts — the single source of truth for Harnu's keyboard
 * shortcuts (T1).
 *
 * Pure module: no `electron` import, no DOM. Imported by
 *   - `src/main/keybindings.ts`  — the file load/save/watch + IPC shell;
 *   - `src/main/menu.ts`         — native-menu accelerator strings;
 *   - the renderer, via `../../../main/keybindings-core` (the same
 *     cross-process pure-core pattern as `pr-stack-core.ts` / `review-core.ts`).
 *
 * It owns three things:
 *   1. the canonical descriptor table (`KEYBINDINGS`) — one row per action,
 *      the ONLY place a default chord is written;
 *   2. a real chord grammar — `parseChord` + `normalizeChord` + two emitters
 *      (`toMagicKeys` for `useShortcuts`, `toAccelerator` for Electron) + a
 *      platform-aware `renderChord` for every `<kbd>` hint in the app;
 *   3. `resolveKeybindings(overrides)` — merge the user's `keybindings.json`
 *      over the defaults, collecting named warnings instead of throwing, and
 *      flag same-scope chord conflicts.
 *
 * See `docs/specs/T1-customizable-keybindings.md`.
 */

/* -------------------------------------------------------------------------- */
/*  Action ids + scopes                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Every action id that can be dispatched. The 26 rebindable renderer bindings
 * (8 of them — the Topbar's per-folder actions and the usage overview — ship
 * with no default chord)
 * plus the reserved `app.*` menu roles. Kept here (not in `menu.ts`) so both
 * processes share one union; `menu.ts` re-exports it for back-compat.
 */
export type ShortcutActionId =
  | 'session.new'
  | 'app.search'
  | 'inbox.toggle'
  | 'view.fleetRail'
  | 'view.toggleSidebar'
  | 'view.toggleHelper'
  | 'project.switch'
  | 'folder.add'
  | 'view.review'
  | 'view.roadmap'
  | 'view.prStack'
  | 'folder.openInFileManager'
  | 'folder.openInVSCode'
  | 'folder.openGithubPulls'
  | 'folder.browseFiles'
  | 'folder.newTerminal'
  | 'view.settings'
  | 'view.usageDashboard'
  | 'session.resumeLast'
  | 'session.rename'
  | 'session.close'
  | 'sidebar.cursor.down'
  | 'sidebar.cursor.up'
  | 'sidebar.cursor.right'
  | 'sidebar.cursor.left'
  | 'sidebar.cursor.activate'
  | 'app.reload'
  | 'app.devtools'
  | 'app.quit'
  | 'app.fullscreen'
  | 'app.openKeybindings'
  // T564 U1 (spec §2.5): the browser pane's own actions, scoped to a focused browser pane.
  | 'browser.overlay.toggle'
  | 'browser.zoom.in'
  | 'browser.zoom.out'
  | 'browser.zoom.reset'
  | 'browser.devtools'
  | 'browser.reload'
  | 'browser.back'
  | 'browser.forward'
  | 'browser.focusAddress'

export type ShortcutScope = 'global' | 'sidebar' | 'terminal' | 'modal' | 'browser'

export interface KeyBindingDescriptor {
  id: ShortcutActionId
  /** Canonical chord string, or `null` for a menu role with no default accelerator. */
  defaultKeys: string | null
  scope: ShortcutScope
  /**
   * Has a native menu item — so the chord fires even while the terminal pane
   * has focus (xterm.js swallows renderer-level keys; the OS menu survives it).
   * A rebound chord on a `menu: false` action works everywhere EXCEPT the
   * terminal pane, which the Settings pane surfaces as a "not in terminal"
   * marker.
   */
  menu: boolean
  /** Un-rebindable. An override targeting a reserved id, or landing on a
   * reserved chord, is rejected at parse with a named warning. */
  reserved: boolean
  /** i18n key for the human-readable action name. */
  labelKey: string
}

/**
 * THE table. Every default chord in Harnu is written here exactly once.
 * `App.vue`'s `useShortcuts([...])`, `menu.ts`'s accelerators, `EmptyState`'s
 * `<kbd>` hints and the `SessionMenu` rename hint all derive from it.
 *
 * Order matters: it is the declaration order `App.vue` registers bindings in,
 * which is what "first-registered wins" resolves against when two bindings
 * share a chord.
 */
export const KEYBINDINGS: readonly KeyBindingDescriptor[] = [
  {
    id: 'session.new',
    defaultKeys: 'Cmd+N',
    scope: 'global',
    menu: true,
    reserved: false,
    labelKey: 'keybindings.actions.session.new'
  },
  {
    id: 'app.search',
    defaultKeys: 'Cmd+K',
    scope: 'global',
    menu: true,
    reserved: false,
    labelKey: 'keybindings.actions.app.search'
  },
  {
    id: 'inbox.toggle',
    defaultKeys: 'Cmd+Shift+A',
    scope: 'global',
    menu: false,
    reserved: false,
    labelKey: 'keybindings.actions.inbox.toggle'
  },
  {
    id: 'view.fleetRail',
    defaultKeys: 'Cmd+Shift+B',
    scope: 'global',
    menu: false,
    reserved: false,
    labelKey: 'keybindings.actions.view.fleetRail'
  },
  {
    id: 'view.toggleSidebar',
    defaultKeys: 'Cmd+B',
    scope: 'global',
    menu: true,
    reserved: false,
    labelKey: 'keybindings.actions.view.toggleSidebar'
  },
  {
    id: 'view.toggleHelper',
    defaultKeys: 'Cmd+Alt+B',
    scope: 'global',
    menu: true,
    reserved: false,
    labelKey: 'keybindings.actions.view.toggleHelper'
  },
  {
    id: 'project.switch',
    defaultKeys: 'Cmd+Shift+P',
    scope: 'global',
    menu: true,
    reserved: false,
    labelKey: 'keybindings.actions.project.switch'
  },
  {
    id: 'folder.add',
    defaultKeys: 'Cmd+O',
    scope: 'global',
    menu: true,
    reserved: false,
    labelKey: 'keybindings.actions.folder.add'
  },
  {
    id: 'view.review',
    defaultKeys: 'Cmd+Shift+D',
    scope: 'global',
    menu: false,
    reserved: false,
    labelKey: 'keybindings.actions.view.review'
  },
  // The Topbar's per-folder actions. No default chord — they ship unbound and
  // are listed so the user can give them one. `menu: true` (the `&Folder` menu
  // in `menu.ts`) so a chord the user binds still fires over the terminal pane.
  {
    id: 'view.roadmap',
    defaultKeys: null,
    scope: 'global',
    menu: true,
    reserved: false,
    labelKey: 'keybindings.actions.view.roadmap'
  },
  {
    id: 'view.prStack',
    defaultKeys: null,
    scope: 'global',
    menu: true,
    reserved: false,
    labelKey: 'keybindings.actions.view.prStack'
  },
  {
    id: 'folder.openInFileManager',
    defaultKeys: null,
    scope: 'global',
    menu: true,
    reserved: false,
    labelKey: 'keybindings.actions.folder.openInFileManager'
  },
  {
    id: 'folder.openInVSCode',
    defaultKeys: null,
    scope: 'global',
    menu: true,
    reserved: false,
    labelKey: 'keybindings.actions.folder.openInVSCode'
  },
  {
    id: 'folder.openGithubPulls',
    defaultKeys: null,
    scope: 'global',
    menu: true,
    reserved: false,
    labelKey: 'keybindings.actions.folder.openGithubPulls'
  },
  {
    id: 'folder.browseFiles',
    defaultKeys: null,
    scope: 'global',
    menu: true,
    reserved: false,
    labelKey: 'keybindings.actions.folder.browseFiles'
  },
  {
    id: 'folder.newTerminal',
    defaultKeys: null,
    scope: 'global',
    menu: true,
    reserved: false,
    labelKey: 'keybindings.actions.folder.newTerminal'
  },
  {
    // ⌘, / Ctrl+, — the platform convention for an app's settings (macOS
    // "Settings…", VS Code "Preferences"). Lives in the app menu on macOS and
    // the File menu elsewhere.
    id: 'view.settings',
    defaultKeys: 'Cmd+,',
    scope: 'global',
    menu: true,
    reserved: false,
    labelKey: 'keybindings.actions.view.settings'
  },
  {
    // The Usage Dashboard takeover (the footer's usage panel → "Open dashboard").
    // No default chord.
    id: 'view.usageDashboard',
    defaultKeys: null,
    scope: 'global',
    menu: true,
    reserved: false,
    labelKey: 'keybindings.actions.view.usageDashboard'
  },
  {
    id: 'session.resumeLast',
    defaultKeys: 'Cmd+Shift+R',
    scope: 'global',
    menu: true,
    reserved: false,
    labelKey: 'keybindings.actions.session.resumeLast'
  },
  {
    id: 'session.rename',
    defaultKeys: 'Cmd+R',
    scope: 'global',
    menu: true,
    reserved: false,
    labelKey: 'keybindings.actions.session.rename'
  },
  {
    id: 'session.close',
    defaultKeys: 'Cmd+W',
    scope: 'global',
    menu: true,
    reserved: false,
    labelKey: 'keybindings.actions.session.close'
  },
  {
    id: 'sidebar.cursor.down',
    defaultKeys: 'ArrowDown',
    scope: 'global',
    menu: false,
    reserved: false,
    labelKey: 'keybindings.actions.sidebar.cursor.down'
  },
  {
    id: 'sidebar.cursor.up',
    defaultKeys: 'ArrowUp',
    scope: 'global',
    menu: false,
    reserved: false,
    labelKey: 'keybindings.actions.sidebar.cursor.up'
  },
  {
    id: 'sidebar.cursor.right',
    defaultKeys: 'ArrowRight',
    scope: 'global',
    menu: false,
    reserved: false,
    labelKey: 'keybindings.actions.sidebar.cursor.right'
  },
  {
    id: 'sidebar.cursor.left',
    defaultKeys: 'ArrowLeft',
    scope: 'global',
    menu: false,
    reserved: false,
    labelKey: 'keybindings.actions.sidebar.cursor.left'
  },
  {
    id: 'sidebar.cursor.activate',
    defaultKeys: 'Enter',
    scope: 'global',
    menu: false,
    reserved: false,
    labelKey: 'keybindings.actions.sidebar.cursor.activate'
  },
  // Reserved — un-rebindable. Handled entirely in the main process.
  {
    id: 'app.reload',
    defaultKeys: 'F5',
    scope: 'global',
    menu: true,
    reserved: true,
    labelKey: 'keybindings.actions.app.reload'
  },
  {
    id: 'app.devtools',
    defaultKeys: 'F12',
    scope: 'global',
    menu: true,
    reserved: true,
    labelKey: 'keybindings.actions.app.devtools'
  },
  {
    id: 'app.quit',
    defaultKeys: 'Cmd+Q',
    scope: 'global',
    menu: true,
    reserved: true,
    labelKey: 'keybindings.actions.app.quit'
  },
  {
    id: 'app.fullscreen',
    defaultKeys: 'F11',
    scope: 'global',
    menu: true,
    reserved: true,
    labelKey: 'keybindings.actions.app.fullscreen'
  },
  {
    // T1 P5 — opens `keybindings.json` in a MarkdownPane helper pane. Reserved
    // (un-rebindable) and its chord is itself reserved (Q5). `menu: true` so
    // the OS consumes ⌘⌥K / Ctrl+Alt+K even over the terminal pane; the actual
    // "open a pane" work is done by the renderer's `useShortcuts` handler.
    id: 'app.openKeybindings',
    defaultKeys: 'Cmd+Alt+K',
    scope: 'global',
    menu: true,
    reserved: true,
    labelKey: 'keybindings.actions.app.openKeybindings'
  },
  {
    id: 'browser.overlay.toggle',
    defaultKeys: 'Cmd+Shift+C',
    scope: 'browser',
    menu: false,
    reserved: false,
    labelKey: 'keybindings.actions.browser.overlay.toggle'
  },
  {
    id: 'browser.zoom.in',
    defaultKeys: 'Cmd+=',
    scope: 'browser',
    menu: false,
    reserved: false,
    labelKey: 'keybindings.actions.browser.zoom.in'
  },
  {
    id: 'browser.zoom.out',
    defaultKeys: 'Cmd+-',
    scope: 'browser',
    menu: false,
    reserved: false,
    labelKey: 'keybindings.actions.browser.zoom.out'
  },
  {
    id: 'browser.zoom.reset',
    defaultKeys: 'Cmd+0',
    scope: 'browser',
    menu: false,
    reserved: false,
    labelKey: 'keybindings.actions.browser.zoom.reset'
  },
  {
    id: 'browser.devtools',
    defaultKeys: 'Cmd+Alt+I',
    scope: 'browser',
    menu: false,
    reserved: false,
    labelKey: 'keybindings.actions.browser.devtools'
  },
  {
    id: 'browser.reload',
    defaultKeys: 'Cmd+R',
    scope: 'browser',
    menu: false,
    reserved: false,
    labelKey: 'keybindings.actions.browser.reload'
  },
  {
    id: 'browser.back',
    defaultKeys: 'Cmd+[',
    scope: 'browser',
    menu: false,
    reserved: false,
    labelKey: 'keybindings.actions.browser.back'
  },
  {
    id: 'browser.forward',
    defaultKeys: 'Cmd+]',
    scope: 'browser',
    menu: false,
    reserved: false,
    labelKey: 'keybindings.actions.browser.forward'
  },
  {
    id: 'browser.focusAddress',
    defaultKeys: 'Cmd+L',
    scope: 'browser',
    menu: false,
    reserved: false,
    labelKey: 'keybindings.actions.browser.focusAddress'
  }
]

export const DESCRIPTOR_BY_ID: Readonly<Record<ShortcutActionId, KeyBindingDescriptor>> =
  Object.fromEntries(KEYBINDINGS.map((d) => [d.id, d])) as Record<
    ShortcutActionId,
    KeyBindingDescriptor
  >

/** The ids a user may rebind — everything not `reserved`. */
export const REBINDABLE_IDS: readonly ShortcutActionId[] = KEYBINDINGS.filter(
  (d) => !d.reserved
).map((d) => d.id)

/** The ids a user may NOT rebind. */
export const RESERVED_IDS: readonly ShortcutActionId[] = KEYBINDINGS.filter((d) => d.reserved).map(
  (d) => d.id
)

/* -------------------------------------------------------------------------- */
/*  Chord grammar                                                             */
/* -------------------------------------------------------------------------- */

export interface Chord {
  /** `Cmd`/`Mod` — ⌘ on macOS, Control everywhere else. */
  cmd: boolean
  /** Explicit `Control` (distinct token; on non-macOS it renders the same as `cmd`). */
  ctrl: boolean
  /** `Alt`/`Option`. */
  alt: boolean
  shift: boolean
  /** The normalized primary key: `'P'`, `'5'`, `'F5'`, `'ArrowDown'`, `'Enter'`, `'/'`. */
  key: string
}

export type ChordParseError =
  'empty' | 'sequence-unsupported' | 'no-key' | 'multiple-keys' | 'bad-key'

export type ChordParseResult = { ok: true; chord: Chord } | { ok: false; code: ChordParseError }

const MOD_ALIASES: Record<string, keyof Pick<Chord, 'cmd' | 'ctrl' | 'alt' | 'shift'>> = {
  cmd: 'cmd',
  mod: 'cmd',
  command: 'cmd',
  meta: 'cmd',
  super: 'cmd',
  win: 'cmd',
  ctrl: 'ctrl',
  control: 'ctrl',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  shift: 'shift'
}

const ARROW_KEYS: Record<string, string> = {
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight'
}

const NAMED_KEYS: Record<string, string> = {
  enter: 'Enter',
  return: 'Enter',
  esc: 'Escape',
  escape: 'Escape',
  space: 'Space',
  spacebar: 'Space',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  insert: 'Insert'
}

const PUNCT_KEYS = new Set(['-', '=', '[', ']', '\\', ';', "'", ',', '.', '/', '`'])

/** Normalize one non-modifier token into a canonical primary key, or `null`. */
function normalizeKeyToken(raw: string): string | null {
  const t = raw.toLowerCase()
  if (/^[a-z]$/.test(t)) return t.toUpperCase()
  if (/^[0-9]$/.test(t)) return t
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(t)) return 'F' + t.slice(1)
  if (ARROW_KEYS[t]) return ARROW_KEYS[t]
  if (NAMED_KEYS[t]) return NAMED_KEYS[t]
  if (PUNCT_KEYS.has(raw)) return raw
  if (t === 'plus') return '='
  return null
}

/**
 * Parse a canonical chord string (`'Cmd+Shift+P'`, `'ArrowDown'`, `'F5'`).
 * Order-insensitive on input. A space anywhere → a two-chord sequence, which
 * v1 does not support (`sequence-unsupported`). Every failure is a code, never
 * a throw.
 */
export function parseChord(input: string): ChordParseResult {
  if (typeof input !== 'string') return { ok: false, code: 'empty' }
  const trimmed = input.trim()
  if (trimmed.length === 0) return { ok: false, code: 'empty' }
  if (/\s/.test(trimmed)) return { ok: false, code: 'sequence-unsupported' }

  // Split on '+', but keep a literal trailing '+' as the key ("Cmd++").
  let tokens = trimmed.split('+')
  if (tokens.length > 1 && tokens[tokens.length - 1] === '') {
    tokens = tokens.slice(0, -1)
    tokens.push('+')
  }

  const chord: Chord = { cmd: false, ctrl: false, alt: false, shift: false, key: '' }
  const keyTokens: string[] = []
  for (const tok of tokens) {
    if (tok === '') continue
    const mod = MOD_ALIASES[tok.toLowerCase()]
    if (mod) {
      chord[mod] = true
      continue
    }
    keyTokens.push(tok)
  }

  if (keyTokens.length === 0) return { ok: false, code: 'no-key' }
  if (keyTokens.length > 1) return { ok: false, code: 'multiple-keys' }
  const key = keyTokens[0] === '+' ? '=' : normalizeKeyToken(keyTokens[0])
  if (key === null) return { ok: false, code: 'bad-key' }
  chord.key = key
  return { ok: true, chord }
}

/** The canonical string form. `Cmd` before `Ctrl` before `Alt` before `Shift`. */
export function normalizeChord(chord: Chord): string {
  const parts: string[] = []
  if (chord.cmd) parts.push('Cmd')
  if (chord.ctrl) parts.push('Ctrl')
  if (chord.alt) parts.push('Alt')
  if (chord.shift) parts.push('Shift')
  parts.push(chord.key)
  return parts.join('+')
}

/**
 * Parse + re-normalize in one step. Returns `null` on any parse failure —
 * callers that need the failure code call `parseChord` directly.
 */
export function canonicalizeChord(input: string): string | null {
  const r = parseChord(input)
  return r.ok ? normalizeChord(r.chord) : null
}

/**
 * `useShortcuts` / `useMagicKeys` shorthand. The canonical form already IS the
 * shorthand for every chord Harnu binds (`'Cmd+N'`, `'ArrowDown'`, `'Enter'`),
 * so this is `normalizeChord` — kept as a named emitter for intent and in case
 * the two grammars ever diverge.
 */
export function toMagicKeys(chord: Chord): string {
  return normalizeChord(chord)
}

const ACCEL_KEYS: Record<string, string> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Enter: 'Return',
  Escape: 'Esc',
  Delete: 'Delete',
  Backspace: 'Backspace',
  Space: 'Space',
  Tab: 'Tab',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Insert: 'Insert'
}

const ACCEL_PUNCT = new Set(['-', '=', '[', ']', '\\', ';', "'", ',', '.', '/', '`'])

/**
 * Electron `accelerator:` string, or `null` when the chord cannot be expressed
 * as one (used to reject an override on a menu-backed action — `not-accelerator`).
 * `Cmd`/`Mod` → `CmdOrCtrl` so one file works on every platform.
 */
export function toAccelerator(chord: Chord): string | null {
  const parts: string[] = []
  if (chord.cmd) parts.push('CmdOrCtrl')
  if (chord.ctrl) parts.push('Ctrl')
  if (chord.alt) parts.push('Alt')
  if (chord.shift) parts.push('Shift')

  const k = chord.key
  let mapped: string | null = null
  if (/^[A-Z0-9]$/.test(k)) mapped = k
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(k)) mapped = k
  else if (ACCEL_KEYS[k]) mapped = ACCEL_KEYS[k]
  else if (ACCEL_PUNCT.has(k)) mapped = k
  if (mapped === null) return null

  parts.push(mapped)
  return parts.join('+')
}

/* -------------------------------------------------------------------------- */
/*  Platform-aware display                                                    */
/* -------------------------------------------------------------------------- */

export interface RenderOpts {
  /** macOS renders `⌘⇧⌥⌃` and concatenates; every other platform spells out
   * `Ctrl` / `Shift` / `Alt` and joins with `+`. */
  mac: boolean
}

const KEY_SYMBOLS_MAC: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Enter: '↩',
  Escape: '⎋',
  Backspace: '⌫',
  Delete: '⌦',
  Space: 'Space',
  Tab: '⇥'
}

const KEY_SYMBOLS_OTHER: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Enter: 'Enter',
  Escape: 'Esc',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Space: 'Space',
  Tab: 'Tab'
}

/** Display tokens for a chord, e.g. `['⌘', '⇧', 'P']` or `['Ctrl', 'Shift', 'P']`. */
export function renderChord(chord: Chord, opts: RenderOpts): string[] {
  const out: string[] = []
  if (opts.mac) {
    if (chord.cmd) out.push('⌘')
    if (chord.ctrl) out.push('⌃')
    if (chord.alt) out.push('⌥')
    if (chord.shift) out.push('⇧')
  } else {
    // On non-mac, `Cmd` IS Control — collapse a `Cmd`+`Ctrl` chord to one token.
    if (chord.cmd || chord.ctrl) out.push('Ctrl')
    if (chord.alt) out.push('Alt')
    if (chord.shift) out.push('Shift')
  }
  const symbols = opts.mac ? KEY_SYMBOLS_MAC : KEY_SYMBOLS_OTHER
  out.push(symbols[chord.key] ?? chord.key)
  return out
}

/** `renderChord` joined: `'⌘⇧P'` on macOS, `'Ctrl+Shift+P'` elsewhere. */
export function renderChordString(chord: Chord, opts: RenderOpts): string {
  return renderChord(chord, opts).join(opts.mac ? '' : '+')
}

/** Render straight from a canonical string; empty array when it does not parse. */
export function renderKeysString(keys: string | null, opts: RenderOpts): string[] {
  if (!keys) return []
  const r = parseChord(keys)
  return r.ok ? renderChord(r.chord, opts) : []
}

/* -------------------------------------------------------------------------- */
/*  KeyboardEvent → Chord (the record-a-chord capture control, P4)            */
/* -------------------------------------------------------------------------- */

const CODE_KEYS: Record<string, string> = {
  Enter: 'Enter',
  NumpadEnter: 'Enter',
  Escape: 'Escape',
  Space: 'Space',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Insert: 'Insert',
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`'
}

export interface KeyEventLike {
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  /** `KeyboardEvent.code` — layout-independent (`'KeyP'`, `'Digit1'`, `'F5'`). */
  code: string
  /** `KeyboardEvent.key` — fallback for `code`s this map does not cover. */
  key: string
}

/**
 * Turn a physical key press into a `Chord`, or `null` when only a modifier is
 * held (the capture control keeps listening until a real key lands).
 *
 * `opts.mac` (default `true`) folds the two "primary" modifiers on non-macOS:
 * there `Ctrl` IS the `Cmd`/`Mod` key (`KeyboardEvent.metaKey` is the Super/Win
 * key and never what a user means by a shortcut), so a `Ctrl+…` press is
 * recorded as the canonical `Cmd+…`. Without this every chord recorded on
 * Linux/Windows came out `Ctrl+…` while all 21 defaults are written `Cmd+…`,
 * so re-recording a row's own default never returned it to `source: 'default'`,
 * conflict grouping never folded the two, and a recorded `Ctrl+Q` slipped past
 * the reserved-chord guard. On macOS the two stay distinct.
 */
export function chordFromEvent(e: KeyEventLike, opts: { mac?: boolean } = {}): Chord | null {
  const mac = opts.mac ?? true
  let key: string | null = null
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3)
  else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5)
  else if (/^Numpad[0-9]$/.test(e.code)) key = e.code.slice(6)
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.code)) key = e.code
  else if (CODE_KEYS[e.code]) key = CODE_KEYS[e.code]
  else if (e.key && e.key.length === 1 && e.key !== ' ') key = normalizeKeyToken(e.key)

  if (key === null) return null
  return {
    cmd: mac ? e.metaKey : e.metaKey || e.ctrlKey,
    ctrl: mac ? e.ctrlKey : false,
    alt: e.altKey,
    shift: e.shiftKey,
    key
  }
}

/* -------------------------------------------------------------------------- */
/*  Resolution: defaults ← overrides, + conflict detection                    */
/* -------------------------------------------------------------------------- */

export type KeybindingWarningCode =
  | 'not-array'
  | 'bad-entry'
  | 'unknown-command'
  | 'reserved-command'
  | 'duplicate-command'
  | 'bad-chord'
  | 'sequence-unsupported'
  | 'reserved-chord'
  | 'scope-immutable'
  | 'not-accelerator'

export interface KeybindingWarning {
  code: KeybindingWarningCode
  command?: string
  key?: string
  detail?: string
}

export interface RawOverrideEntry {
  key?: string | null
  command?: string
  scope?: string
}

export interface ResolvedBinding {
  id: ShortcutActionId
  /** Resolved canonical chord — `null` means the user unbound it. */
  keys: string | null
  defaultKeys: string | null
  scope: ShortcutScope
  menu: boolean
  reserved: boolean
  labelKey: string
  source: 'default' | 'override' | 'unbound'
  /** Other action ids sharing this chord in this scope (both participants marked). */
  conflictsWith: ShortcutActionId[]
}

export interface ResolvedKeybindings {
  /**
   * Keyed by action id. **Partial** on purpose: `list` (and therefore this map)
   * is built from the rebindable rows only, so the reserved ids (`app.quit`,
   * `app.reload`, `app.devtools`, `app.fullscreen`, `app.openKeybindings`) are
   * absent at runtime. Every read site guards with `?.` / `if (rb)`; the type
   * now says so instead of an `as` cast that papered over it.
   */
  byId: Partial<Record<ShortcutActionId, ResolvedBinding>>
  /** In `KEYBINDINGS` declaration order, with the reserved rows filtered out. */
  list: ResolvedBinding[]
  warnings: KeybindingWarning[]
}

/**
 * The comparison key for "this chord, in this scope" — the one shape shared by
 * reserved-chord detection and same-scope conflict grouping.
 *
 * The separator is a spaced ` ~ `: neither a scope name nor a canonical chord
 * contains it, and unlike the raw NUL byte it replaced it does not make the
 * source file read as binary to search / indexing tools.
 *
 * `mac === false` folds `Ctrl+` onto `Cmd+` first: off macOS the two are the
 * same physical key, so a hand-edited `Ctrl+Q` must still trip the reserved
 * `Cmd+Q` guard and `Ctrl+B` must group with the default `Cmd+B`. On macOS the
 * two are genuinely different chords and are kept apart.
 *
 * Exported so `useShortcuts` keys its renderer-watcher claim set the same way:
 * off macOS a hand-edited `Ctrl+B` and the default `Cmd+B` are one claim, so
 * only the first-registered action gets a watcher (T1 review, PR #337).
 */
export function scopeChordKey(scope: ShortcutScope, chord: string, mac: boolean): string {
  const folded = mac ? chord : chord.replace(/Ctrl\+/g, 'Cmd+').replace(/Cmd\+Cmd\+/g, 'Cmd+')
  return `${scope} ~ ${folded}`
}

/** Chords occupied by reserved actions — an override may never land on one. */
function reservedChordKeys(mac: boolean): Set<string> {
  const s = new Set<string>()
  for (const d of KEYBINDINGS) {
    if (!d.reserved || !d.defaultKeys) continue
    const c = canonicalizeChord(d.defaultKeys)
    if (c) s.add(scopeChordKey(d.scope, c, mac))
  }
  return s
}

/**
 * Merge `raw` (the parsed `keybindings.json` array) over the defaults.
 *
 * - `raw == null` → defaults only (still runs conflict detection).
 * - `raw` not an array → `not-array` warning, defaults only.
 * - one entry per `command`, last wins (`duplicate-command`).
 * - `"key": null`, or a `-`-prefixed `command`, unbinds the default. A missing
 *   or non-string `key` (e.g. `{ "command": "session.new" }`) is a `bad-entry`,
 *   NOT a silent unbind — the spec's only unbind gestures are `null` and
 *   `-command`.
 * - every rejection is a collected `KeybindingWarning`; nothing throws.
 *
 * `opts.mac` decides whether `Ctrl` and `Cmd` are folded for the reserved-chord
 * guard and conflict grouping — see {@link scopeChordKey}. It defaults to `true`
 * (macOS semantics, no fold) only so the unit tests can stay terse; this module
 * is pure and cannot probe the platform itself. Every real caller passes it
 * explicitly and an off-macOS one MUST: the renderer store passes `isMac`, and
 * both `keybindings-file.ts` loaders pass `process.platform === 'darwin'`, so a
 * future non-test call site has a defaulted example next to it, not a trap.
 */
export function resolveKeybindings(
  raw: unknown,
  opts: { mac?: boolean } = {}
): ResolvedKeybindings {
  const mac = opts.mac ?? true
  const warnings: KeybindingWarning[] = []
  const overrideKeys = new Map<ShortcutActionId, string | null>()
  const overridden = new Set<ShortcutActionId>()

  if (raw != null) {
    if (!Array.isArray(raw)) {
      warnings.push({ code: 'not-array' })
    } else {
      const reserved = reservedChordKeys(mac)
      const seen = new Set<string>()
      for (const item of raw) {
        if (item == null || typeof item !== 'object') {
          warnings.push({ code: 'bad-entry' })
          continue
        }
        const entry = item as RawOverrideEntry
        let command = typeof entry.command === 'string' ? entry.command.trim() : ''
        let unbind = entry.key === null
        if (command.startsWith('-')) {
          command = command.slice(1)
          unbind = true
        }
        if (!command) {
          warnings.push({ code: 'bad-entry' })
          continue
        }
        const descriptor = DESCRIPTOR_BY_ID[command as ShortcutActionId]
        if (!descriptor) {
          warnings.push({ code: 'unknown-command', command })
          continue
        }
        if (descriptor.reserved) {
          warnings.push({ code: 'reserved-command', command })
          continue
        }
        if (seen.has(command)) warnings.push({ code: 'duplicate-command', command })
        seen.add(command)

        if (
          typeof entry.scope === 'string' &&
          entry.scope.length > 0 &&
          entry.scope !== descriptor.scope
        ) {
          warnings.push({ code: 'scope-immutable', command, detail: entry.scope })
          continue
        }

        if (unbind) {
          overrideKeys.set(descriptor.id, null)
          overridden.add(descriptor.id)
          continue
        }

        // Not an unbind, so `key` must be a real chord string. A missing key or
        // a non-string is a malformed entry — never silently treated as
        // "unbind" (that would let `{ "command": "session.new" }` kill a
        // default with no gesture from the user).
        if (typeof entry.key !== 'string') {
          warnings.push({ code: 'bad-entry', command })
          continue
        }

        const parsed = parseChord(entry.key)
        if (!parsed.ok) {
          warnings.push({
            code: parsed.code === 'sequence-unsupported' ? 'sequence-unsupported' : 'bad-chord',
            command,
            key: String(entry.key)
          })
          continue
        }
        const canonical = normalizeChord(parsed.chord)
        if (reserved.has(scopeChordKey(descriptor.scope, canonical, mac))) {
          warnings.push({ code: 'reserved-chord', command, key: canonical })
          continue
        }
        if (descriptor.menu && toAccelerator(parsed.chord) === null) {
          warnings.push({ code: 'not-accelerator', command, key: canonical })
          continue
        }
        overrideKeys.set(descriptor.id, canonical)
        overridden.add(descriptor.id)
      }
    }
  }

  // Build the resolved list.
  const list: ResolvedBinding[] = KEYBINDINGS.filter((d) => !d.reserved).map((d) => {
    const has = overridden.has(d.id)
    const keys = has ? (overrideKeys.get(d.id) ?? null) : d.defaultKeys
    const source: ResolvedBinding['source'] = !has
      ? 'default'
      : keys === null
        ? 'unbound'
        : 'override'
    return {
      id: d.id,
      keys,
      defaultKeys: d.defaultKeys,
      scope: d.scope,
      menu: d.menu,
      reserved: d.reserved,
      labelKey: d.labelKey,
      source,
      conflictsWith: []
    }
  })

  // Conflict detection: same normalized chord, same scope, any origin. Uses the
  // same platform-folded key as the reserved guard so `Ctrl+B` and `Cmd+B`
  // group together on Linux/Windows (one physical press fires both watchers).
  const groups = new Map<string, ResolvedBinding[]>()
  for (const b of list) {
    if (!b.keys) continue
    const k = scopeChordKey(b.scope, b.keys, mac)
    const g = groups.get(k)
    if (g) g.push(b)
    else groups.set(k, [b])
  }
  for (const g of groups.values()) {
    if (g.length < 2) continue
    for (const b of g) b.conflictsWith = g.filter((o) => o.id !== b.id).map((o) => o.id)
  }

  const byId: Partial<Record<ShortcutActionId, ResolvedBinding>> = Object.fromEntries(
    list.map((b) => [b.id, b])
  )
  return { byId, list, warnings }
}

/**
 * Strip `//` line comments and `/* *\/` block comments from a JSONC string so
 * `JSON.parse` accepts VS Code-style annotated `keybindings.json`. String
 * literals are respected — a `//` inside `"..."` is left alone.
 */
export function stripJsonComments(input: string): string {
  let out = ''
  let inString = false
  let inLine = false
  let inBlock = false
  for (let i = 0; i < input.length; i++) {
    const c = input[i]
    const next = input[i + 1]
    if (inLine) {
      if (c === '\n') {
        inLine = false
        out += c
      }
      continue
    }
    if (inBlock) {
      if (c === '*' && next === '/') {
        inBlock = false
        i++
      }
      continue
    }
    if (inString) {
      out += c
      if (c === '\\') {
        out += next ?? ''
        i++
      } else if (c === '"') {
        inString = false
      }
      continue
    }
    if (c === '"') {
      inString = true
      out += c
      continue
    }
    if (c === '/' && next === '/') {
      inLine = true
      i++
      continue
    }
    if (c === '/' && next === '*') {
      inBlock = true
      i++
      continue
    }
    out += c
  }
  return out
}

/**
 * Full parse of a `keybindings.json` file body: strip comments, `JSON.parse`,
 * resolve. A parse failure is a single `not-array` warning with the defaults
 * kept — the file never fails the app closed. `opts.mac` is forwarded to
 * {@link resolveKeybindings} (see its `Ctrl`/`Cmd` fold note).
 */
export function parseKeybindingsFile(
  body: string,
  opts: { mac?: boolean } = {}
): ResolvedKeybindings {
  let raw: unknown = null
  const trimmed = body.trim()
  if (trimmed.length > 0) {
    try {
      raw = JSON.parse(stripJsonComments(body))
    } catch {
      return {
        ...resolveKeybindings(null, opts),
        warnings: [{ code: 'not-array', detail: 'invalid JSON' }]
      }
    }
  }
  return resolveKeybindings(raw, opts)
}
