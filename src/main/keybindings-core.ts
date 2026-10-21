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
 * Every action id that can be dispatched: the rebindable renderer bindings
 * (most ship with no default chord — T486 gave every user-invokable action an
 * id) plus the reserved `app.*` menu roles. Kept here (not in `menu.ts`) so both
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
  | 'session.newInFolder'
  | 'session.fork'
  | 'session.openToSide'
  | 'session.contextMenu'
  | 'session.restart'
  | 'session.copyId'
  | 'session.copyTranscriptPath'
  | 'session.copyResumeCommand'
  | 'session.copyContextDigest'
  | 'session.toggleNoFlicker'
  | 'session.toggleArchived'
  | 'session.delete'
  | 'session.retryBoot'
  | 'session.dismiss'
  | 'session.closeTerminal'
  | 'sidebar.jump'
  | 'sidebar.rescan'
  | 'sidebar.cycleDrillDepth'
  | 'sidebar.toggleCollapseAll'
  | 'sidebar.hiddenFolders'
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

export type ShortcutScope = 'global' | 'sidebar' | 'terminal' | 'modal'

/**
 * The Settings pane's group headers (T486 §5.2), in display order. Every
 * descriptor belongs to exactly one; a group with no visible row is hidden.
 */
export type KeybindingGroup =
  'sessions' | 'sidebar' | 'folders' | 'views' | 'panes' | 'takeovers' | 'app'

export const KEYBINDING_GROUPS: readonly KeybindingGroup[] = [
  'sessions',
  'sidebar',
  'folders',
  'views',
  'panes',
  'takeovers',
  'app'
]

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
  /** i18n key for the human-readable action name — always `labelKeyFor(id)`. */
  labelKey: string
  /** The Settings pane group the row is listed under (T486). */
  group: KeybindingGroup
  /** false ⇒ never listed in the command palette (T486 §9). Default true. */
  palette?: boolean
  /** Listed in the palette's empty-query view (T486 §9). Default false. */
  paletteFeatured?: boolean
}

/**
 * The i18n key for an action's label. The ids contain dots and vue-i18n reads a
 * key as a dotted PATH, so `keybindings.actions.session.new` would walk
 * `actions → session → new` and miss; the locale files store each label under
 * the id with every `.` written as `_` (`keybindings.actions.session_new`).
 * Nothing builds a label key from an id any other way (T486 §4).
 */
export function labelKeyFor(id: string): string {
  return 'keybindings.actions.' + id.replace(/\./g, '_')
}

interface DefOpts {
  scope?: ShortcutScope
  menu?: boolean
  reserved?: boolean
  palette?: boolean
  paletteFeatured?: boolean
}

/** One table row. `scope` defaults to `'global'`, `menu`/`reserved` to false. */
function def(
  id: ShortcutActionId,
  group: KeybindingGroup,
  defaultKeys: string | null,
  opts: DefOpts = {}
): KeyBindingDescriptor {
  return {
    id,
    defaultKeys,
    scope: opts.scope ?? 'global',
    menu: opts.menu ?? false,
    reserved: opts.reserved ?? false,
    labelKey: labelKeyFor(id),
    group,
    palette: opts.palette ?? true,
    paletteFeatured: opts.paletteFeatured ?? false
  }
}

const MENU = { menu: true } as const

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
  def('session.new', 'sessions', 'Cmd+N', { ...MENU, paletteFeatured: true }),
  // Opens the palette itself, so it is never listed in it.
  def('app.search', 'app', 'Cmd+K', { ...MENU, palette: false }),
  def('inbox.toggle', 'views', 'Cmd+Shift+A', { paletteFeatured: true }),
  // Alias of `inbox.toggle` — listing it would show the same action twice.
  def('view.fleetRail', 'views', 'Cmd+Shift+B', { palette: false }),
  def('view.toggleSidebar', 'views', 'Cmd+B', MENU),
  def('view.toggleHelper', 'views', 'Cmd+Alt+B', MENU),
  def('project.switch', 'app', 'Cmd+Shift+P', { ...MENU, palette: false }),
  def('folder.add', 'folders', 'Cmd+O', { ...MENU, paletteFeatured: true }),
  def('view.review', 'takeovers', 'Cmd+Shift+D'),
  // The Topbar's per-folder actions. No default chord — they ship unbound and
  // are listed so the user can give them one. `menu: true` (the `&Folder` menu
  // in `menu.ts`) so a chord the user binds still fires over the terminal pane.
  def('view.roadmap', 'takeovers', null, MENU),
  def('view.prStack', 'takeovers', null, MENU),
  def('folder.openInFileManager', 'folders', null, MENU),
  def('folder.openInVSCode', 'folders', null, MENU),
  def('folder.openGithubPulls', 'folders', null, MENU),
  def('folder.browseFiles', 'folders', null, MENU),
  def('folder.newTerminal', 'folders', null, MENU),
  // ⌘, / Ctrl+, — the platform convention for an app's settings (macOS
  // "Settings…", VS Code "Preferences"). Lives in the app menu on macOS and
  // the File menu elsewhere.
  def('view.settings', 'views', 'Cmd+,', MENU),
  // The Usage Dashboard takeover (the footer's usage panel → "Open dashboard").
  // No default chord.
  def('view.usageDashboard', 'takeovers', null, MENU),
  def('session.resumeLast', 'sessions', 'Cmd+Shift+R', { ...MENU, paletteFeatured: true }),
  def('session.rename', 'sessions', 'Cmd+R', MENU),
  def('session.close', 'sessions', 'Cmd+W', MENU),
  // T486 §3.2 — the Session menu's items and the folder `+`. Unbound except two
  // sidebar-navigation gestures: ⌘↩ / Ctrl+↩ opens to the side, ⇧F10 opens the
  // context menu. `session.fork` ships unbound (operator decision, 2026-10-14).
  def('session.newInFolder', 'sessions', null),
  def('session.fork', 'sessions', null),
  def('session.openToSide', 'sessions', 'Cmd+Enter'),
  // Focus-dependent (it targets the cursor row), so never listed in the palette.
  def('session.contextMenu', 'sessions', 'Shift+F10', { palette: false }),
  def('session.restart', 'sessions', null),
  def('session.copyId', 'sessions', null),
  def('session.copyTranscriptPath', 'sessions', null),
  def('session.copyResumeCommand', 'sessions', null),
  def('session.copyContextDigest', 'sessions', null),
  def('session.toggleNoFlicker', 'sessions', null),
  def('session.toggleArchived', 'sessions', null),
  def('session.delete', 'sessions', null),
  def('session.retryBoot', 'sessions', null),
  def('session.dismiss', 'sessions', null),
  def('session.closeTerminal', 'sessions', null),
  // T486 §3.3 — the sidebar header's buttons. ⌘⇧F / Ctrl+Shift+F toggles the
  // jump palette; xterm sends nothing for a Ctrl/⌘+Shift+letter chord, so it
  // fires over a focused terminal although it has no menu item.
  def('sidebar.jump', 'sidebar', 'Cmd+Shift+F'),
  def('sidebar.rescan', 'sidebar', null),
  def('sidebar.cycleDrillDepth', 'sidebar', null),
  def('sidebar.toggleCollapseAll', 'sidebar', null),
  def('sidebar.hiddenFolders', 'sidebar', null),
  def('sidebar.cursor.down', 'sidebar', 'ArrowDown', { palette: false }),
  def('sidebar.cursor.up', 'sidebar', 'ArrowUp', { palette: false }),
  def('sidebar.cursor.right', 'sidebar', 'ArrowRight', { palette: false }),
  def('sidebar.cursor.left', 'sidebar', 'ArrowLeft', { palette: false }),
  def('sidebar.cursor.activate', 'sidebar', 'Enter', { palette: false }),
  // Reserved — un-rebindable. Handled entirely in the main process, so none of
  // them has a renderer handler the palette could run.
  def('app.reload', 'app', 'F5', { ...MENU, reserved: true, palette: false }),
  def('app.devtools', 'app', 'F12', { ...MENU, reserved: true, palette: false }),
  def('app.quit', 'app', 'Cmd+Q', { ...MENU, reserved: true, palette: false }),
  def('app.fullscreen', 'app', 'F11', { ...MENU, reserved: true, palette: false }),
  // T1 P5 — opens `keybindings.json` in a MarkdownPane helper pane. Reserved
  // (un-rebindable) and its chord is itself reserved (Q5). `menu: true` so
  // the OS consumes ⌘⌥K / Ctrl+Alt+K even over the terminal pane; the actual
  // "open a pane" work is done by the renderer's `useShortcuts` handler, which
  // is also why it stays in the palette.
  def('app.openKeybindings', 'app', 'Cmd+Alt+K', { ...MENU, reserved: true })
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
/*  Settings pane search (T486 §5.2)                                          */
/* -------------------------------------------------------------------------- */

const MAC_MODIFIER_SYMBOLS: Record<string, string> = {
  '⌘': 'Cmd',
  '⇧': 'Shift',
  '⌥': 'Alt',
  '⌃': 'Ctrl'
}

/** The macOS key glyphs `renderChord` emits, mapped back to grammar tokens. */
const MAC_KEY_SYMBOLS: Record<string, string> = {
  '↑': 'ArrowUp',
  '↓': 'ArrowDown',
  '←': 'ArrowLeft',
  '→': 'ArrowRight',
  '↩': 'Enter',
  '⎋': 'Escape',
  '⌫': 'Backspace',
  '⌦': 'Delete',
  '⇥': 'Tab'
}

/**
 * How the pane's search reads a query:
 * - `chord` — the query is unmistakably a key combo (`Ctrl+J`, `ctrl+shift+f`,
 *   `F6`, `Esc`, `⌘K`); keep exactly the rows bound to it.
 * - `union` — a lone named key (`delete`, `left`, `tab`) is also an ordinary
 *   word, so keep the chord matches AND the text matches ("delete" must still
 *   find "Delete the session…" while that row is unbound).
 * - `text` — a case-insensitive substring of label, rendered chord or id.
 */
export type ShortcutQuery =
  { mode: 'text'; needle: string } | { mode: 'chord' | 'union'; needle: string; chord: string }

export function parseShortcutQuery(query: string): ShortcutQuery {
  const q = query.trim()
  const needle = q.toLowerCase()
  if (!q) return { mode: 'text', needle }
  // "Ctrl+" is a combo still being typed, not `Ctrl+=` (`Cmd++` stays a chord).
  if (q.endsWith('+') && !q.endsWith('++')) return { mode: 'text', needle }

  const hasSymbol = /[⌘⇧⌥⌃]/.test(q)
  let candidate = q
  if (hasSymbol) {
    const mods: string[] = []
    let rest = ''
    for (const ch of q) {
      if (MAC_MODIFIER_SYMBOLS[ch]) mods.push(MAC_MODIFIER_SYMBOLS[ch])
      else rest += ch
    }
    rest = rest.replace(/^\++/, '')
    candidate = [...mods, MAC_KEY_SYMBOLS[rest] ?? rest].filter(Boolean).join('+')
  }

  const parsed = parseChord(candidate)
  if (!parsed.ok) return { mode: 'text', needle }
  const c = parsed.chord
  const chord = normalizeChord(c)
  const modified = c.cmd || c.ctrl || c.alt || c.shift
  if (hasSymbol || q.includes('+') || modified || /^F\d+$/.test(c.key) || c.key === 'Escape') {
    return { mode: 'chord', needle, chord }
  }
  // A named key (`Delete`, `ArrowLeft`, `Tab`…) — not a single letter, digit or
  // punctuation mark, which only ever mean text.
  if (c.key.length > 1) return { mode: 'union', needle, chord }
  return { mode: 'text', needle }
}

export interface SearchableBinding {
  id: string
  keys: string | null
  scope: ShortcutScope
}

/**
 * Does `row` (its label already resolved in the active locale) match `query`?
 * Chord equality goes through {@link scopeChordKey}, so off macOS a typed
 * `Ctrl+B` finds the `Cmd+B` default.
 */
export function matchesShortcutQuery(
  row: SearchableBinding,
  label: string,
  query: ShortcutQuery,
  mac: boolean
): boolean {
  if (!query.needle) return true
  const byChord = (): boolean => {
    if (query.mode === 'text' || !row.keys) return false
    const keys = canonicalizeChord(row.keys)
    if (!keys) return false
    return scopeChordKey(row.scope, keys, mac) === scopeChordKey(row.scope, query.chord, mac)
  }
  const byText = (): boolean => {
    const rendered = renderKeysString(row.keys, { mac }).join(mac ? '' : '+')
    return [label, rendered, row.id].some((s) => s.toLowerCase().includes(query.needle))
  }
  if (query.mode === 'chord') return byChord()
  if (query.mode === 'union') return byChord() || byText()
  return byText()
}

/**
 * A chord the recorder must refuse for this action because it can never fire
 * (T486 §5.2, AC-50). A `menu: false` action's only path is the renderer's
 * `useMagicKeys` watcher, which matches on the lowercased `e.code` and `e.key`;
 * Shift rewrites `e.key` for punctuation (`⌘⇧,` arrives as `<`), and on macOS
 * Option rewrites it for letters (`⌥A` arrives as `å`), so neither combo ever
 * matches. A menu-backed action fires through its native accelerator instead.
 * (U5a widens the exemption to shielded actions.)
 */
export function isUnreachableChord(chord: Chord, d: { menu: boolean }, mac: boolean): boolean {
  if (d.menu) return false
  if (chord.shift && PUNCT_KEYS.has(chord.key)) return true
  if (mac && chord.alt && /^[A-Z]$/.test(chord.key)) return true
  return false
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
