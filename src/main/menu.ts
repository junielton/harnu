import { Menu, app, BrowserWindow } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import {
  DESCRIPTOR_BY_ID,
  defaultKeysFor,
  parseChord,
  toAccelerator,
  type ResolvedKeybindings,
  type ShortcutActionId as KeybindingActionId
} from './keybindings-core'

/**
 * Canonical action IDs emitted over the `shortcut:fired` IPC channel. The
 * rebindable + reserved ids live in `keybindings-core.ts` (shared with the
 * renderer + the `keybindings.json` layer, T1), `nav.back` / `nav.forward`
 * included since T486 U5a: their platform-split default is `defaultKeysMac`.
 *
 * Two items short-circuit the IPC roundtrip:
 *   - `app.reload` calls `webContents.reload()` directly (special case — the
 *     renderer obviously can't reload itself reliably).
 *   - `app.devtools` toggles devtools on the main window directly for the
 *     same reason — the renderer has no privileged handle to do so.
 *
 * Everything else is emitted as `shortcut:fired` so the renderer's
 * `useShortcuts` dispatch table handles it.
 */
export type ShortcutActionId = KeybindingActionId

const isMac = process.platform === 'darwin'

/**
 * The Electron `accelerator:` string for an action, resolved against the user's
 * `keybindings.json` when a `resolved` table is passed (T1 P3) and falling back
 * to the canonical default from `keybindings-core.ts` otherwise. Reserved ids
 * (`app.*`) are never in the resolved map, so they always take their default.
 *
 * Returns `undefined` when the action is unbound (`"key": null`), or has no
 * default chord and no override, so the menu item is built without an
 * accelerator — the OS-level chord goes away, matching the renderer.
 *
 * Throws only on a programming error: a chord that does not parse / is not an
 * accelerator. Default chords are asserted by `keybindings-core.test.ts`; a
 * resolved override that reaches here has already passed the identical
 * `not-accelerator` check inside `resolveKeybindings`.
 */
export function accel(
  id: KeybindingActionId,
  resolved?: ResolvedKeybindings | null
): string | undefined {
  const rb = resolved?.byId[id]
  const keys = rb ? rb.keys : defaultKeysFor(DESCRIPTOR_BY_ID[id], isMac)
  if (keys === null) return undefined
  if (!keys) throw new Error(`[menu] ${id} has no default chord`)
  const parsed = parseChord(keys)
  if (!parsed.ok) throw new Error(`[menu] ${id} chord "${keys}" does not parse`)
  const a = toAccelerator(parsed.chord)
  if (!a) throw new Error(`[menu] ${id} chord "${keys}" is not an Electron accelerator`)
  return a
}

/**
 * Build the application menu template. Each entry that maps to a known
 * action ID emits `shortcut:fired` to the focused window. We intentionally
 * avoid Electron's built-in `role: 'reload' | 'forceReload' | ...` for the
 * actions that the renderer also wants to drive — the only exceptions are
 * `reload` and `toggleDevTools`, which are physically tied to the main
 * process (the renderer can't reload itself reliably) but we still emit
 * the IPC event in case the renderer wants to react (e.g. snapshot scroll
 * position before reload).
 *
 * On macOS we include the standard `editMenu` / `windowMenu` roles so
 * ⌘C/⌘V/⌘X/⌘A/⌘Z work inside `<input>` and `<textarea>` (without these
 * macOS strips them in packaged builds).
 */
export function buildAppMenu(
  getWindow: () => BrowserWindow | null,
  resolved?: ResolvedKeybindings | null
): Menu {
  function emit(actionId: ShortcutActionId): void {
    const win = getWindow()
    win?.webContents.send('shortcut:fired', actionId)
  }

  // Override-aware accelerator for this build (T1 P3). `undefined` for an
  // unbound action drops the `accelerator` key entirely.
  const a = (id: KeybindingActionId): string | undefined => accel(id, resolved)

  // T486 §10 — Settings on its Keyboard Shortcuts tab (⌘⌥S / Ctrl+Alt+S). One
  // item, placed once per platform, so the accelerator has a single owner.
  const keyboardShortcutsItem: MenuItemConstructorOptions = {
    label: 'Keyboard Shortcuts…',
    accelerator: a('view.settings.keybindings'),
    click: (): void => emit('view.settings.keybindings')
  }

  const template: MenuItemConstructorOptions[] = [
    // macOS application menu — only present on darwin. The `appMenu` role
    // would auto-populate this, but we want the explicit Quit accelerator
    // to emit our own action ID, so we build it manually.
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              {
                label: 'Settings…',
                accelerator: a('view.settings'),
                click: (): void => emit('view.settings')
              },
              // T486 §10 — next to Settings…, where Mac users look for
              // preferences. View holds it on Linux / Windows instead.
              keyboardShortcutsItem,
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              {
                label: `Quit ${app.name}`,
                accelerator: a('app.quit'),
                click: (): void => {
                  emit('app.quit')
                  app.quit()
                }
              }
            ]
          }
        ] as MenuItemConstructorOptions[])
      : []),

    {
      label: '&File',
      submenu: [
        {
          label: 'New Session',
          accelerator: a('session.new'),
          click: (): void => emit('session.new')
        },
        {
          label: 'Add Folder…',
          accelerator: a('folder.add'),
          click: (): void => emit('folder.add')
        },
        { type: 'separator' },
        {
          label: 'Close Session',
          accelerator: a('session.close'),
          // Soft-handled: T-4.5 will conditionally suppress this in the
          // renderer when the terminal pane has focus so xterm/Ctrl+W
          // forwards through to the PTY. Until then the renderer simply
          // closes the active tab.
          click: (): void => emit('session.close')
        },
        // On Linux/Windows the application menu also owns Settings and Quit
        // (macOS has both in the app menu above).
        ...((!isMac
          ? [
              { type: 'separator' },
              {
                label: 'Settings…',
                accelerator: a('view.settings'),
                click: (): void => emit('view.settings')
              },
              { type: 'separator' },
              {
                label: 'Quit',
                accelerator: a('app.quit'),
                click: (): void => {
                  emit('app.quit')
                  app.quit()
                }
              }
            ]
          : []) as MenuItemConstructorOptions[])
      ]
    },

    // Standard Edit menu via the `editMenu` role — gives us cut/copy/paste/
    // undo/selectAll bound to the OS-native accelerators. Required on macOS
    // so text-editing chords work inside `<input>` / `<textarea>`.
    { role: 'editMenu', label: '&Edit' },

    {
      label: '&Session',
      submenu: [
        {
          label: 'Resume Last Session',
          accelerator: a('session.resumeLast'),
          click: (): void => emit('session.resumeLast')
        },
        {
          label: 'Rename',
          accelerator: a('session.rename'),
          // The menu accelerator overrides the default Electron `reload`
          // binding for ⌘R, so we move reload to F5 in the View menu.
          click: (): void => emit('session.rename')
        },
        {
          label: 'Search',
          accelerator: a('app.search'),
          click: (): void => emit('app.search')
        },
        {
          label: 'Switch Project…',
          accelerator: a('project.switch'),
          click: (): void => emit('project.switch')
        },
        { type: 'separator' },
        // Session navigation history (docs/specs/2026-10-06-session-nav-history.md
        // §5.3), rebindable since T486 U5a: ⌘[ / ⌘] on macOS, Alt+← / Alt+→
        // elsewhere by default. On Linux/Windows this accelerator only fires for a
        // key the page left unhandled, and xterm handles Alt+← / Alt+→, so the
        // renderer's shield (App.vue) stops the bound chord in the capture phase
        // before xterm sees it — accepted trade-off D-4: it no longer reaches the
        // terminal.
        {
          label: 'Back',
          accelerator: a('nav.back'),
          click: (): void => emit('nav.back')
        },
        {
          label: 'Forward',
          accelerator: a('nav.forward'),
          click: (): void => emit('nav.forward')
        }
      ]
    },

    {
      // The Topbar's per-folder actions. They ship with no default accelerator;
      // the items exist so a chord the user binds in keybindings.json is owned at
      // the OS level (and so fires over the terminal pane), like every other
      // menu-backed action.
      label: 'F&older',
      submenu: [
        {
          label: 'Roadmap Board',
          accelerator: a('view.roadmap'),
          click: (): void => emit('view.roadmap')
        },
        {
          label: 'PR Stack',
          accelerator: a('view.prStack'),
          click: (): void => emit('view.prStack')
        },
        { type: 'separator' },
        {
          label: 'Browse Files',
          accelerator: a('folder.browseFiles'),
          click: (): void => emit('folder.browseFiles')
        },
        {
          label: 'New Terminal',
          accelerator: a('folder.newTerminal'),
          click: (): void => emit('folder.newTerminal')
        },
        { type: 'separator' },
        {
          label: 'Open in File Manager',
          accelerator: a('folder.openInFileManager'),
          click: (): void => emit('folder.openInFileManager')
        },
        {
          label: 'Open in Editor',
          accelerator: a('folder.openInEditor'),
          click: (): void => emit('folder.openInEditor')
        },
        {
          label: 'Pull Requests on GitHub',
          accelerator: a('folder.openGithubPulls'),
          click: (): void => emit('folder.openGithubPulls')
        }
      ]
    },

    {
      label: '&View',
      submenu: [
        // Layout collapse toggles (design.md §6 — Colapsar sidebars). Bound at
        // the menu level so the OS consumes ⌘B / ⌘⌥B before xterm can — the
        // only reliable way to steal a ⌘/Ctrl chord from the terminal pane (the
        // same reason ⌘N / ⌘K live here). The renderer double-binds both as a
        // fallback for WMs that drop accelerators.
        {
          label: 'Toggle Sidebar',
          accelerator: a('view.toggleSidebar'),
          click: (): void => emit('view.toggleSidebar')
        },
        {
          label: 'Toggle Panel',
          accelerator: a('view.toggleHelper'),
          click: (): void => emit('view.toggleHelper')
        },
        {
          // No default accelerator; present so a chord the user binds is owned
          // at the OS level, like the Folder menu items.
          label: 'Usage Overview',
          accelerator: a('view.usageDashboard'),
          click: (): void => emit('view.usageDashboard')
        },
        { type: 'separator' },
        // T486 §10 — the Settings tab itself; in the app menu on macOS.
        ...(isMac ? [] : [keyboardShortcutsItem]),
        {
          // T1 P5 — opens keybindings.json in the MarkdownPane helper pane. The
          // renderer's `useShortcuts` handler does the actual open; this item
          // just owns the ⌘⌥K / Ctrl+Alt+K accelerator at the OS level.
          label: 'Open keybindings.json',
          accelerator: a('app.openKeybindings'),
          click: (): void => emit('app.openKeybindings')
        },
        { type: 'separator' },
        {
          label: 'Reload',
          accelerator: a('app.reload'),
          // Special case: also reload the renderer immediately. The IPC emit
          // lets the renderer log/snapshot before the actual reload happens.
          click: (): void => {
            emit('app.reload')
            const win = getWindow()
            win?.webContents.reload()
          }
        },
        {
          label: 'Toggle DevTools',
          // Two accelerators historically: F12 (Windows/Linux convention) and
          // CmdOrCtrl+Shift+I (cross-platform browser convention). Electron
          // only honors one accelerator per item, so pick F12 — devs on macOS
          // can still open devtools via the menu item or the standard
          // `Cmd+Option+I` chord which Electron binds by default on the
          // `toggleDevTools` role. Since we're not using that role here, we
          // also need a click handler.
          accelerator: a('app.devtools'),
          click: (): void => {
            emit('app.devtools')
            const win = getWindow()
            win?.webContents.toggleDevTools()
          }
        },
        { type: 'separator' },
        {
          label: 'Toggle Fullscreen',
          accelerator: a('app.fullscreen'),
          click: (): void => {
            emit('app.fullscreen')
            const win = getWindow()
            if (win) win.setFullScreen(!win.isFullScreen())
          }
        }
      ]
    },

    // Standard Window menu via the `windowMenu` role on macOS (Minimize/Zoom/
    // Front etc.). On Linux/Windows the role still produces a usable Minimize/
    // Close item set, which is fine.
    { role: 'windowMenu', label: '&Window' }
  ]

  return Menu.buildFromTemplate(template)
}

/**
 * Install the application menu. On macOS this becomes the system menubar;
 * on Linux/Windows the menu is hidden (the BrowserWindow's
 * `autoHideMenuBar: true` keeps the bar off-screen) but the accelerators
 * still fire because `Menu.setApplicationMenu(menu)` installs them at the
 * OS level — they're the most reliable way to bind ⌘/Ctrl chords because
 * xterm.js inside the terminal pane cannot intercept them.
 *
 * Do not pass `null` to `Menu.setApplicationMenu` on Linux/Windows just to
 * hide the bar — that also discards every accelerator binding.
 *
 * `resolved` is the `keybindings.json`-merged table (T1 P3). Pass it so the
 * OS-level accelerators match the user's overrides; omit it and the menu is
 * built from the canonical defaults.
 */
export function registerAppMenu(
  getWindow: () => BrowserWindow | null,
  resolved?: ResolvedKeybindings | null
): void {
  rebuildAppMenu(getWindow, resolved)
}

/**
 * Re-install the application menu from a fresh resolved table. Called on every
 * `keybindings:changed` (T1 P3) so a hand-edit to `keybindings.json` re-binds
 * the native accelerators without a restart — `Menu.setApplicationMenu`
 * replaces the previous menu and its OS-level bindings wholesale.
 */
export function rebuildAppMenu(
  getWindow: () => BrowserWindow | null,
  resolved?: ResolvedKeybindings | null
): void {
  Menu.setApplicationMenu(buildAppMenu(getWindow, resolved))
}
