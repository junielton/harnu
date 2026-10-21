import { onBeforeUnmount, ref, watch, type WatchStopHandle } from 'vue'
import { useMagicKeys } from '@vueuse/core'
import { isMac } from '../lib/platform'
import {
  DESCRIPTOR_BY_ID,
  KEYBINDINGS,
  canonicalizeChord,
  chordFromEvent,
  normalizeChord,
  parseChord,
  scopeChordKey,
  type ResolvedKeybindings,
  type ShortcutActionId
} from '../../../main/keybindings-core'

/**
 * Keyboard-shortcut composable for the renderer.
 *
 * Two dispatch surfaces feed a single registration table:
 *
 *  1. **OS application menu** (T-4.1 — `src/main/menu.ts`). The native menu
 *     binds accelerators (`CmdOrCtrl+N`, etc.) at the OS level, so xterm.js
 *     inside the terminal pane cannot intercept them. Each menu item fires
 *     `shortcut:fired` over IPC with a string action id (`session.new`,
 *     `app.search`, …).
 *
 *  2. **Renderer-level `useMagicKeys` watchers** (this file). For shortcuts
 *     that are NOT in the OS menu — `F2`, arrow keys, `Esc` — or that must
 *     fire even when the menu happens to be disabled, each binding may
 *     declare a `keys` shorthand (`'Cmd+Shift+P'`, `'F2'`, `'Cmd+K'`). The
 *     composable wires a `watch` on the matching `useMagicKeys` ref.
 *
 *  3. **The shield** (T486 §7.4 — {@link createShieldListener}). A shielded
 *     action's chord is matched in the window CAPTURE phase, before xterm can
 *     turn it into terminal input. It is the only key path a shielded action
 *     has: no `useMagicKeys` watcher is wired for it.
 *
 * Every surface ultimately resolves through `dispatch(actionId)`, which picks
 * the highest-precedence binding for the **active scope** and calls it.
 *
 * See `findings/07-shortcuts-palette.md` §2/§4 and `design.md §6` for the
 * full shortcut matrix this is sized for.
 */

/**
 * Scopes form a stack. The top of the stack determines which bindings fire;
 * `'global'` is permanently at the bottom and acts as the fallback. So if a
 * modal pushes `'modal'`, only `'modal'` bindings fire until `popScope`
 * restores the prior top. There is no notion of "modal + sidebar both
 * active": the top wins outright.
 *
 * The four scopes are sized for v1 — extend the union here when introducing
 * a new top-of-stack surface.
 */
export type ShortcutScope = 'global' | 'sidebar' | 'terminal' | 'modal'

/**
 * Declaration of one keyboard shortcut.
 *
 * A binding always has an `id` (so the OS menu can target it) and a
 * `handler`. The `keys` field is optional — bindings without `keys` only
 * fire when the OS menu emits `shortcut:fired` for `id`. Bindings WITH
 * `keys` ALSO listen for the renderer-level chord, which is the only way
 * to bind keys that are not in the OS menu (e.g. `F2`, arrow navigation).
 */
export interface ShortcutBinding {
  /** Action identifier, e.g. `'session.new'`. Matches the IPC payload. */
  id: string
  /**
   * Scope this binding lives in. Only bindings whose scope is the current
   * top of the scope stack (or `'global'` when no scope has been pushed)
   * are dispatched.
   */
  scope: ShortcutScope
  /**
   * Optional renderer-level key binding in `useMagicKeys` shorthand —
   * `'Cmd+Shift+P'`, `'F2'`, `'Cmd+K'`. `Cmd` and `Mod` are translated
   * cross-platform: they map to `meta` on macOS and `control` everywhere
   * else (via the `aliasMap` we pass to `useMagicKeys`). If omitted, the
   * handler ONLY fires from the OS-menu IPC channel.
   */
  keys?: string
  /**
   * Optional precondition — CONTEXT only (a selection exists, a takeover is
   * open, …). Evaluated at dispatch time for every source. If it returns
   * `false`, the handler is skipped.
   */
  enabled?: () => boolean
  /**
   * Optional FOCUS-conflict check (T486 §9.1), consulted only for a `'keys'`
   * dispatch — a press that really came from the focused element. Typically
   * `notInTextEntry` (`lib/text-entry.ts`), so a text field keeps its own
   * keys. Never consulted for the native menu, the shield or the palette:
   * those run the action whatever holds focus.
   */
  keysGuard?: () => boolean
  /** The work to perform. Async handlers are awaited only via their promise
   * — `dispatch` is not async itself and does not wait. */
  handler: () => void | Promise<void>
}

/* -------------------------------------------------------------------------- */
/*  Module-level state                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Global binding table. Every `useShortcuts(...)` call appends its
 * registrations here and removes them in `onBeforeUnmount`. Lookups in
 * `dispatch` scan this list filtered by scope + id; the first match wins.
 *
 * We do NOT attempt to build a priority tree — the spec calls for "top of
 * stack wins" and "warn if two bindings register for the same id+scope and
 * call only the first". An array gives both behaviors trivially.
 */
const registrations: ShortcutBinding[] = []

/**
 * Bumped whenever {@link registrations} changes, so a computed that reads
 * {@link isShortcutEnabled} (the palette's Actions list) re-evaluates when a
 * binding is added or removed. The array itself stays non-reactive.
 */
const registrationsVersion = ref(0)

/**
 * Stack of active scopes. `'global'` is always at the bottom. `pushScope`
 * appends, `popScope` removes the topmost occurrence. The current top
 * (`scopeStack[scopeStack.length - 1]`) is the only scope whose bindings
 * fire, except that `'global'` bindings are NEVER consulted while a
 * non-global scope is on top (this matches the spec's "scopes shadow each
 * other" rule; modals override sidebar AND global).
 */
const scopeStack: ShortcutScope[] = ['global']

/**
 * Number of component instances currently using the composable. We
 * subscribe to the IPC channel exactly once when the count transitions
 * 0 → 1, and unsubscribe when it transitions 1 → 0. In v1 the composable
 * is mounted exactly once from `App.vue`, but the counter keeps the
 * lifecycle correct under future re-use (e.g. unit tests, HMR).
 */
let installCount = 0

/**
 * Disposer returned by `window.api.onShortcut(...)` — kept module-scoped
 * so the last-uninstall hook can call it. `null` while no installation
 * is active.
 */
let ipcUnsubscribe: (() => void) | null = null

/**
 * Which surface a `dispatch` came from — the OS application menu accelerator
 * (`shortcut:fired` IPC), the renderer-level `useMagicKeys` fallback, the
 * capture-phase terminal shield (T486 U5a) or the command palette (U6). Only
 * `'keys'` consults a binding's `keysGuard`.
 */
export type DispatchSource = 'menu' | 'keys' | 'shield' | 'palette'

/**
 * De-dup window for the intentional double-bind (BUG-21). Menu-owned chords fire
 * from BOTH surfaces for a SINGLE physical press — the OS accelerator emits
 * `shortcut:fired` (`'menu'`) AND the renderer `useMagicKeys` watcher matches
 * (`'keys'`). Left unchecked every menu chord ran twice on Linux: invisible for
 * idempotent actions (open palette, add folder), but net-zero for toggles
 * (Ctrl+B collapse only flickered) and duplicating for the rest (Ctrl+N → two
 * sessions). See {@link dispatch}.
 */
const DOUBLE_BIND_COALESCE_MS = 250

/**
 * Last EXECUTED dispatch per action id — `{source, at}`. `dispatch` drops a call
 * for the same id that arrives from a DIFFERENT source inside
 * {@link DOUBLE_BIND_COALESCE_MS} (the twin of a single press), while a repeat
 * from the SAME source — or an id with no menu twin, e.g. the arrow keys — always
 * runs. Dropped calls are NOT recorded, so a genuine second press still fires.
 */
const lastDispatch = new Map<string, { source: DispatchSource; at: number }>()

/* -------------------------------------------------------------------------- */
/*  Platform detection + key normalization                                    */
/* -------------------------------------------------------------------------- */

/* `isMac` is detected in `lib/platform.ts` (imported above). */

/**
 * Custom alias map for `useMagicKeys`.
 *
 * `useMagicKeys` splits a key string on `+`, `_`, `-` and lower-cases each
 * token, then looks up tokens in the alias map. The default map (see
 * `node_modules/@vueuse/core/dist/index.js`) translates `cmd` → `meta`,
 * `ctrl` → `control`, etc. — but it does NOT swap `cmd` for `control` on
 * non-macOS platforms, which is the cross-platform behavior we want.
 *
 * So we layer our own map on top: `cmd` and `mod` both resolve to `meta`
 * on macOS and `control` elsewhere. The remaining defaults are preserved
 * by spreading the upstream `DefaultMagicKeysAliasMap` — except that the
 * upstream map is not exported, so we re-declare its few entries inline.
 * That tiny duplication is the price of staying typed without monkey-
 * patching the package.
 */
const ALIAS_MAP: Record<string, string> = {
  // Upstream defaults we want to keep.
  ctrl: 'control',
  command: 'meta',
  option: 'alt',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  // Our cross-platform overrides.
  cmd: isMac ? 'meta' : 'control',
  mod: isMac ? 'meta' : 'control'
}

/**
 * The shared `useMagicKeys` instance. Created lazily on first install so
 * that no `keydown` listener attaches in renderers that never instantiate
 * the composable (e.g. preview builds rendered headlessly for tests). The
 * `passive: false` setting is what lets binding handlers `preventDefault`
 * the browser's native chord (e.g. Cmd+R reload, Cmd+W close) — without
 * it `useMagicKeys` registers as a passive listener and the OS / browser
 * default fires alongside our handler.
 *
 * The aliasMap is passed once at construction; changes to it later are
 * not picked up (vueuse captures it by reference in a Proxy `get` trap).
 * Don't mutate `ALIAS_MAP` after the first `useShortcuts(...)` call.
 */
type MagicKeys = ReturnType<typeof useMagicKeys<false>>
let magic: MagicKeys | null = null

/**
 * The modifier state of the last `keydown` `useMagicKeys` saw — the press a
 * chord watcher is reacting to (the watcher runs in the microtask right after
 * that listener). See {@link modifiersMatchExactly}.
 */
let lastKeydown: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'> | null = null

function getMagic(): MagicKeys {
  if (!magic) {
    magic = useMagicKeys<false>({
      passive: false,
      aliasMap: ALIAS_MAP,
      onEventFired: (e) => {
        if (e.type === 'keydown') lastKeydown = e
      }
    })
  }
  return magic
}

/** The four modifier keys a chord can declare, in `useMagicKeys`' canonical names. */
const MODIFIER_KEYS = ['control', 'meta', 'shift', 'alt'] as const
type ModifierKey = (typeof MODIFIER_KEYS)[number]

/**
 * The modifier set a `keys` shorthand declares, after alias resolution (`Cmd` →
 * `control`/`meta`, `Ctrl` → `control`, …). Powers the exact-match guard in the
 * renderer watcher — see {@link modifiersMatchExactly}.
 */
function declaredModifiers(keysStr: string): Set<ModifierKey> {
  const out = new Set<ModifierKey>()
  for (const raw of keysStr.toLowerCase().split(/[+_-]/)) {
    const token = ALIAS_MAP[raw] ?? raw
    if ((MODIFIER_KEYS as readonly string[]).includes(token)) out.add(token as ModifierKey)
  }
  return out
}

/**
 * When `chordStr`'s primary key is one `useMagicKeys`' `/[+_-]/` tokenizer would
 * eat, the `useMagicKeys` prop to watch instead, else `null`. In Harnu's grammar
 * that key is only `-` (`=` and the rest survive the tokenizer). `keys['Cmd+-']`
 * is permanently `false` (`['cmd','','']` → a `.every(Boolean)` computed), and
 * `keys['-']` is no better since `e.key` flips to `'_'` when Shift is held. The
 * `e.code` name is layout- and Shift-stable — `Minus` lowercased to `'minus'`,
 * a single token the tokenizer leaves alone — and vueuse tracks a ref for it.
 */
function splitHostileKey(chordStr: string): string | null {
  const r = parseChord(chordStr)
  if (!r.ok) return null
  return r.chord.key === '-' ? 'minus' : null
}

/**
 * True iff the held modifiers EXACTLY match `declared` (none extra, none missing).
 * `useMagicKeys` combos are SUBSET matches — `control+b` stays true while
 * `control+shift+b` is held — so without this Ctrl+Shift+B would spuriously fire the
 * Ctrl+B binding (collapsing the sidebar) on top of `view.fleetRail` (BUG-21).
 *
 * "Held" is read from the key press itself (`shiftKey`, `ctrlKey`, …), not from
 * `useMagicKeys`' modifier refs: those drift from the keyboard whenever a modifier's
 * own keydown or keyup never reaches `window` (a field that stops it, a lost keyup,
 * a synthesized key event), and then `F7` fired on Shift+F7 (T486 U4a, live). The
 * refs are the fallback only before any keydown has been seen.
 */
function modifiersMatchExactly(keys: MagicKeys, declared: ReadonlySet<ModifierKey>): boolean {
  const e = lastKeydown
  const held: Record<ModifierKey, boolean> = e
    ? { control: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey, alt: e.altKey }
    : {
        control: keys.control?.value === true,
        meta: keys.meta?.value === true,
        shift: keys.shift?.value === true,
        alt: keys.alt?.value === true
      }
  for (const mod of MODIFIER_KEYS) {
    if (held[mod] !== declared.has(mod)) return false
  }
  return true
}

/* -------------------------------------------------------------------------- */
/*  IPC bridge                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Shape of the preload bridge for the menu IPC. Declared locally rather
 * than imported because T-4.1 (which adds `onShortcut` to the preload
 * `Api`) lands in parallel with this task — typing it here keeps the file
 * compiling whether or not T-4.1 has already merged. Once both are in,
 * the `Api` type will have `onShortcut` natively and the cast in
 * `getOnShortcut` becomes a no-op.
 */
interface ShortcutBridge {
  onShortcut?: (cb: (actionId: string) => void) => () => void
}

/**
 * Safely access `window.api.onShortcut`. Returns `null` if the preload
 * hasn't installed the bridge yet (during T-4.1's in-flight window, or in
 * test environments where `window.api` is stubbed). The composable still
 * wires renderer-level key dispatch in that case — only the OS-menu leg
 * is missing.
 */
function getOnShortcut(): ShortcutBridge['onShortcut'] | null {
  if (typeof window === 'undefined') return null
  const api = (window as unknown as { api?: ShortcutBridge }).api
  return api?.onShortcut ?? null
}

/* -------------------------------------------------------------------------- */
/*  Dispatch                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Resolve and run the binding for `id` in the currently-active scope.
 *
 * Rules (mirrors the task spec exactly):
 *   - The top of `scopeStack` is the "active" scope.
 *   - Only bindings whose `scope` equals the active scope are eligible.
 *     Specifically — if the active scope is NOT `'global'`, `'global'`
 *     bindings do NOT fire. Modals shadow everything.
 *   - If multiple bindings target the same id in the active scope, the
 *     first one registered wins and the rest emit a one-shot warning.
 *   - `enabled()` is consulted last. If it returns `false`, dispatch
 *     falls through silently (no warning, no fallback to a different
 *     scope — that's intentional, it keeps "when-clause"-style guards
 *     local to the binding that declared them).
 */
export function activeScope(): ShortcutScope {
  return scopeStack[scopeStack.length - 1] ?? 'global'
}

/**
 * Run the binding for `id` as if it came from `source` — the shield's door
 * (T486 §7.4); the palette uses {@link invokeShortcut}. Same rules as every dispatch:
 * active scope, `enabled()`, the menu/keys coalescing; `keysGuard` only for
 * `'keys'`.
 */
export function dispatchShortcut(id: string, source: DispatchSource): void {
  dispatch(id, source)
}

/** The first `'global'` registration for `id` — the palette's door (T486 §9.1). */
function globalBinding(id: string): ShortcutBinding | undefined {
  void registrationsVersion.value
  return registrations.find((r) => r.id === id && r.scope === 'global')
}

/**
 * Whether `id` has a `'global'` registration whose `enabled()` holds right now —
 * the palette lists only those (T486 §9.1). Context only: `keysGuard` and the
 * active scope are not consulted, so an action guarded against a text field is
 * still listed while the palette's own input has focus. Reactive when read in a
 * computed: `enabled()` reads store state, and a (un)registration bumps a ref.
 */
export function isShortcutEnabled(id: string): boolean {
  const binding = globalBinding(id)
  return !!binding && (!binding.enabled || binding.enabled())
}

/**
 * Run the first `'global'` registration for `id` from the palette (T486 §9.1):
 * `enabled()` is checked, `keysGuard` and the active scope are not (the
 * palette's own `'modal'` scope is still on the stack at activation), and no
 * menu/keys coalescing applies. Returns whether the handler ran.
 */
export function invokeShortcut(id: string): boolean {
  const binding = globalBinding(id)
  if (!binding || (binding.enabled && !binding.enabled())) return false
  void binding.handler()
  return true
}

/** Test-only alias of {@link dispatchShortcut}. */
export function dispatchForTests(id: string, source: DispatchSource): void {
  dispatch(id, source)
}

/**
 * The shield (T486 §7.4): one window CAPTURE `keydown` listener for every
 * shielded action. `App.vue` installs it; nothing else catches a shielded chord.
 *
 * 1. Stand down unless the global scope is on top — dialogs, the palette and the
 *    menus keep their keys.
 * 2. Build the press's chord from the physical key (`chordFromEvent`, `e.code`)
 *    and compare it, under the platform fold, with each shielded action's
 *    RESOLVED chord — so a rebind moves the shield with it.
 * 3. On a match:
 *    - **menu-backed, off macOS** (`nav.*`): `stopPropagation()` only. xterm never
 *      sees the key, but it stays UNHANDLED, so Electron runs the native
 *      accelerator, which dispatches through `shortcut:fired`. Calling
 *      `preventDefault` would also hide it from Electron's menu-bar logic, which
 *      then reads the Alt release as a lone Alt press and toggles the auto-hidden
 *      menu bar.
 *    - **otherwise**: `preventDefault()` + `stopPropagation()` + a `'shield'`
 *      dispatch. A menu accelerator twin of the same press is coalesced.
 */
export function createShieldListener(
  resolvedKeybindings: () => ResolvedKeybindings | null
): (e: KeyboardEvent) => void {
  const shielded = KEYBINDINGS.filter((d) => d.shield)
  return (e) => {
    if (activeScope() !== 'global') return
    const chord = chordFromEvent(e, { mac: isMac })
    if (!chord) return
    const resolved = resolvedKeybindings()
    for (const d of shielded) {
      const keys = resolved?.byId[d.id]?.keys
      const canonical = keys ? canonicalizeChord(keys) : null
      if (!canonical) continue
      if (
        scopeChordKey(d.scope, canonical, isMac) !==
        scopeChordKey(d.scope, normalizeChord(chord), isMac)
      ) {
        continue
      }
      e.stopPropagation()
      if (d.menu && !isMac) return
      e.preventDefault()
      dispatch(d.id, 'shield')
      return
    }
  }
}

/** Test-only: restore the scope stack to its initial `['global']` state. */
export function resetScopesForTests(): void {
  scopeStack.length = 0
  scopeStack.push('global')
}

function dispatch(id: string, source: DispatchSource): void {
  // BUG-21: swallow the twin of a single double-bound press. A same-id call from
  // the OTHER surface within the coalesce window is the menu/keys duplicate — drop
  // it WITHOUT recording, so a genuine repeat from the same surface still fires.
  const now = Date.now()
  const prev = lastDispatch.get(id)
  if (prev && prev.source !== source && now - prev.at < DOUBLE_BIND_COALESCE_MS) return

  const scope = activeScope()
  const matches = registrations.filter((r) => r.id === id && r.scope === scope)
  if (matches.length === 0) return
  if (matches.length > 1) {
    console.warn(
      `[useShortcuts] multiple bindings for id="${id}" in scope="${scope}"; using the first registered.`
    )
  }
  const binding = matches[0]
  if (binding.enabled && !binding.enabled()) return
  if (source === 'keys' && binding.keysGuard && !binding.keysGuard()) return
  lastDispatch.set(id, { source, at: now })
  // Intentionally not awaited — fire-and-forget. Async handlers that need
  // error reporting should `.catch` internally; we don't centralize that
  // because shortcut handlers are arbitrary user code.
  void binding.handler()
}

/* -------------------------------------------------------------------------- */
/*  Scope stack — exported for modals / sidebar focus / etc.                  */
/* -------------------------------------------------------------------------- */

/**
 * Push a new scope onto the stack. Until a matching `popScope`, only
 * bindings registered in this scope fire. Call from `onMounted` /
 * `watch(open)` of any UI surface that wants exclusive shortcut focus:
 *
 *     // AddFolderDialog.vue
 *     watch(() => ui.dialogOpen, (open) => {
 *       if (open) pushScope('modal')
 *       else popScope('modal')
 *     })
 *
 * Pushing `'global'` is allowed but pointless — it's already at the
 * bottom of the stack, so it has no effect.
 */
export function pushScope(scope: ShortcutScope): void {
  scopeStack.push(scope)
}

/**
 * Pop the topmost occurrence of `scope` from the stack. Idempotent: if
 * `scope` isn't on the stack (or has already been popped), this is a
 * no-op. We pop the topmost occurrence rather than blindly popping the
 * top to make ordering bugs more forgiving — a modal closing late won't
 * accidentally pop a sidebar scope that was pushed afterwards.
 *
 * `'global'` cannot be popped — it is the implicit base of the stack
 * and removing it would break `activeScope()`.
 */
export function popScope(scope: ShortcutScope): void {
  if (scope === 'global') return
  for (let i = scopeStack.length - 1; i >= 0; i--) {
    if (scopeStack[i] === scope) {
      scopeStack.splice(i, 1)
      return
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Main entry point                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Register a set of shortcut bindings for the lifetime of the calling
 * component. Bindings are removed automatically on `onBeforeUnmount`, and
 * the underlying IPC subscription tears down when the last consumer
 * unmounts.
 *
 * Typical usage (mounted ONCE from `App.vue` in v1; T-4.4 fills the
 * handlers):
 *
 *     useShortcuts([
 *       { id: 'session.new',  scope: 'global', keys: 'Cmd+N',       handler: () => sessions.createNew() },
 *       { id: 'app.search',   scope: 'global', keys: 'Cmd+K',       handler: () => ui.openPalette() },
 *       { id: 'folder.rename', scope: 'global', keys: 'F2',         handler: () => ui.openRenameFolder(path) },
 *       // Bindings without `keys` rely solely on the OS menu emitting
 *       // `shortcut:fired` over IPC (T-4.1).
 *       { id: 'project.switch', scope: 'global',                    handler: () => ui.openSwitchProject() },
 *     ])
 *
 * Pass `resolvedKeybindings` (a getter for the keybindings store's resolved
 * table, T1 P2) to make the renderer-level chord watchers track
 * `keybindings.json` overrides: the effective chord for a binding becomes
 * `resolved.byId[id].keys` (falling back to the binding's own `keys` for ids the
 * table doesn't cover), and the watchers are torn down + rebuilt whenever the
 * resolved table changes — so a hand-edit re-keys the app live. `keys === null`
 * in the resolved table means the user unbound the action: no renderer watcher
 * is wired for it.
 */
export function useShortcuts(
  bindings: ShortcutBinding[],
  resolvedKeybindings?: () => ResolvedKeybindings | null
): void {
  // 1. Append every binding to the registry. We keep a local snapshot
  //    of the exact references so the unmount hook can splice them out
  //    without ambiguity (in case the caller mutates the input array).
  const owned = [...bindings]
  registrations.push(...owned)
  registrationsVersion.value++

  // 2. Wire renderer-level key watchers for every binding whose effective
  //    chord is non-empty. `useMagicKeys` produces a ComputedRef<boolean>
  //    per chord; we watch each ref and dispatch on the rising edge. When
  //    `resolved` is supplied the wiring is rebuilt on every change to it,
  //    so an override applied at runtime re-keys the watchers.
  const keys = getMagic()

  /** Effective chord for a binding: the resolved override, else its own `keys`. */
  function effectiveChord(binding: ShortcutBinding): string | undefined {
    const resolved = resolvedKeybindings?.()
    if (resolved) {
      const rb = resolved.byId[binding.id as ShortcutActionId]
      // A row in the table wins outright — including `keys: null` (unbound),
      // which yields `undefined` here so no watcher is wired.
      if (rb) return rb.keys ?? undefined
    }
    return binding.keys
  }

  let keyWatchStops: WatchStopHandle[] = []
  function rewireKeyWatchers(): void {
    for (const stop of keyWatchStops) stop()
    keyWatchStops = []
    // "First-registered wins, the chord still dispatches once" (spec Q7): when
    // two bindings resolve to the same chord in the same scope, only the
    // earlier-registered one gets a renderer watcher. Both are still badged as a
    // conflict (`conflictsWith` in the resolved table); the loser just doesn't
    // fire a second handler off one physical press. `owned` is in `App.vue`
    // declaration order, which IS the registration order the spec means.
    const claimedChords = new Set<string>()
    for (const binding of owned) {
      // A shielded action's only key path is the shield (T486 §7.4), so one press
      // dispatches once.
      if (DESCRIPTOR_BY_ID[binding.id as ShortcutActionId]?.shield) continue
      const chordStr = effectiveChord(binding)
      if (!chordStr) continue
      const claimKey = scopeChordKey(binding.scope, chordStr, isMac)
      if (claimedChords.has(claimKey)) continue
      claimedChords.add(claimKey)
      // The exact set of modifiers this chord declares — checked at fire time so a
      // superset chord (Ctrl+Shift+B) never trips this subset binding (Ctrl+B). BUG-21.
      const declaredMods = declaredModifiers(chordStr)

      // `useMagicKeys`' string proxy tokenizes on `/[+_-]/`, so a chord whose
      // PRIMARY key is `-` (e.g. `Cmd+-`, spec-legal — `-` is in the key
      // grammar) becomes `['cmd','','']` and its computed is permanently
      // `false`: a silently dead binding, with no menu leg to fall back on for a
      // `menu: false` action. Address those by the layout-stable `e.code` name
      // (`Minus`), which vueuse still tracks a ref for. (`-` is the only grammar
      // key the tokenizer eats; `=` and the rest are safe.)
      const watchKey = splitHostileKey(chordStr) ?? chordStr
      const chord = keys[watchKey]
      if (!chord) {
        // Shouldn't happen — useMagicKeys creates refs lazily for any accessed
        // prop — but guard in case vueuse internals change.
        console.warn(`[useShortcuts] could not resolve key "${watchKey}" for id="${binding.id}".`)
        continue
      }
      const pressedRef = (): boolean => chord.value

      keyWatchStops.push(
        watch(pressedRef, (pressed) => {
          // Fire only on the rising edge. `useMagicKeys` flips to `true` on
          // keydown and `false` on keyup, so we'd dispatch twice without this.
          if (!pressed) return
          if (!modifiersMatchExactly(keys, declaredMods)) return
          dispatch(binding.id, 'keys')
        })
      )
    }
  }
  rewireKeyWatchers()
  // Rebuild the watchers whenever the resolved table is replaced (the store
  // swaps the whole object on load / `keybindings:changed`, so a shallow watch
  // on the getter is enough). Kept out of `keyWatchStops` so a rewire doesn't
  // stop itself.
  const stopResolvedWatch = resolvedKeybindings
    ? watch(resolvedKeybindings, rewireKeyWatchers)
    : null

  // 3. On the first installation, subscribe to the OS-menu IPC channel.
  //    Subsequent installations share the same subscription. The disposer
  //    is stored module-scoped so the last unmount can call it.
  installCount++
  if (installCount === 1) {
    const onShortcut = getOnShortcut()
    if (onShortcut) {
      ipcUnsubscribe = onShortcut((actionId) => dispatch(actionId, 'menu'))
    }
  }

  // 4. Cleanup. Explicitly stop the chord watchers + the resolved-table
  //    watcher (they're rebuilt on every rewire, so component-scope
  //    auto-cleanup isn't enough to bound their count), splice our bindings
  //    out, and decrement the installation counter. The IPC subscription is
  //    released when the counter hits zero. Note: we do NOT clear the scope
  //    stack here — pushScope / popScope are the responsibility of whichever
  //    component pushed the scope, and an unrelated useShortcuts unmount
  //    should not yank scopes pushed by other components.
  onBeforeUnmount(() => {
    for (const stop of keyWatchStops) stop()
    keyWatchStops = []
    stopResolvedWatch?.()
    for (const binding of owned) {
      const i = registrations.indexOf(binding)
      if (i >= 0) registrations.splice(i, 1)
    }
    registrationsVersion.value++
    installCount--
    if (installCount === 0 && ipcUnsubscribe) {
      ipcUnsubscribe()
      ipcUnsubscribe = null
    }
  })
}
