import { onBeforeUnmount, watch } from 'vue'
import { useMagicKeys } from '@vueuse/core'
import { isMac } from '../lib/platform'

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
 * Both surfaces ultimately resolve through `dispatch(actionId)`, which picks
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
   * Optional precondition. Evaluated at dispatch time. If it returns
   * `false`, the handler is skipped and dispatch falls through to the next
   * matching binding (if any).
   */
  enabled?: () => boolean
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
 * (`shortcut:fired` IPC) or the renderer-level `useMagicKeys` fallback.
 */
type DispatchSource = 'menu' | 'keys'

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
function getMagic(): MagicKeys {
  if (!magic) {
    magic = useMagicKeys<false>({
      passive: false,
      aliasMap: ALIAS_MAP
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
 * True iff the currently-held modifiers EXACTLY match `declared` (none extra, none
 * missing). `useMagicKeys` combos are SUBSET matches — `control+b` stays true while
 * `control+shift+b` is held — so without this Ctrl+Shift+B would spuriously fire the
 * Ctrl+B binding (collapsing the sidebar) on top of `view.fleetRail` (BUG-21).
 * Requiring an exact modifier match keeps each chord to its own binding.
 */
function modifiersMatchExactly(keys: MagicKeys, declared: ReadonlySet<ModifierKey>): boolean {
  for (const mod of MODIFIER_KEYS) {
    const held = keys[mod]?.value === true
    if (held !== declared.has(mod)) return false
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
 *       { id: 'session.rename', scope: 'global', keys: 'F2',        handler: () => sessions.beginRename() },
 *       // Bindings without `keys` rely solely on the OS menu emitting
 *       // `shortcut:fired` over IPC (T-4.1).
 *       { id: 'project.switch', scope: 'global',                    handler: () => ui.openSwitchProject() },
 *     ])
 */
export function useShortcuts(bindings: ShortcutBinding[]): void {
  // 1. Append every binding to the registry. We keep a local snapshot
  //    of the exact references so the unmount hook can splice them out
  //    without ambiguity (in case the caller mutates the input array).
  const owned = [...bindings]
  registrations.push(...owned)

  // 2. Wire renderer-level key watchers for every binding that declared
  //    a `keys` field. `useMagicKeys` produces a ComputedRef<boolean>
  //    per chord; we watch each ref and dispatch on the rising edge. The
  //    watcher uses the component scope, so cleanup is automatic on
  //    unmount.
  const keys = getMagic()
  for (const binding of owned) {
    if (!binding.keys) continue
    const chord = keys[binding.keys]
    if (!chord) {
      // This shouldn't happen — useMagicKeys creates refs lazily for any
      // accessed prop — but guard anyway in case vueuse internals change.
      console.warn(`[useShortcuts] could not resolve key "${binding.keys}" for id="${binding.id}".`)
      continue
    }
    // The exact set of modifiers this chord declares — checked at fire time so a
    // superset chord (Ctrl+Shift+B) never trips this subset binding (Ctrl+B). BUG-21.
    const declaredMods = declaredModifiers(binding.keys)
    watch(chord, (pressed) => {
      // Fire only on the rising edge. `useMagicKeys` flips the ref to
      // `true` on keydown and `false` on keyup, so we'd dispatch twice
      // per chord without this guard.
      if (!pressed) return
      if (!modifiersMatchExactly(keys, declaredMods)) return
      dispatch(binding.id, 'keys')
    })
  }

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

  // 4. Cleanup. Watchers above auto-clean via component scope; we only
  //    need to splice our bindings out and decrement the installation
  //    counter. The IPC subscription is released when the counter hits
  //    zero. Note: we do NOT clear the scope stack here — pushScope /
  //    popScope are the responsibility of whichever component pushed
  //    the scope, and an unrelated useShortcuts unmount should not
  //    yank scopes pushed by other components.
  onBeforeUnmount(() => {
    for (const binding of owned) {
      const i = registrations.indexOf(binding)
      if (i >= 0) registrations.splice(i, 1)
    }
    installCount--
    if (installCount === 0 && ipcUnsubscribe) {
      ipcUnsubscribe()
      ipcUnsubscribe = null
    }
  })
}
