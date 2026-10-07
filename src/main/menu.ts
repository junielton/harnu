import { Menu, app, BrowserWindow } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'

/**
 * Canonical action IDs emitted over the `shortcut:fired` IPC channel.
 *
 * Each menu item's `click` handler emits exactly one of these IDs to the
 * renderer, which then dispatches the work via `useShortcuts` (T-4.2/T-4.4).
 * Keep this union in sync with `findings/07-shortcuts-palette.md` §2 and
 * the table in T-4.1.
 *
 * Two items short-circuit the IPC roundtrip:
 *   - `app.reload` calls `webContents.reload()` directly (special case — the
 *     renderer obviously can't reload itself reliably).
 *   - `app.devtools` toggles devtools on the main window directly for the
 *     same reason — the renderer has no privileged handle to do so.
 *
 * Everything else is emitted as `shortcut:fired` so T-4.4 wires a single
 * dispatch table in the renderer.
 */
export type ShortcutActionId =
  | 'session.new'
  | 'app.search'
  | 'project.switch'
  | 'folder.add'
  | 'session.resumeLast'
  | 'session.rename'
  | 'session.close'
  | 'view.toggleSidebar'
  | 'view.toggleHelper'
  | 'app.reload'
  | 'app.devtools'
  | 'app.quit'
  | 'app.fullscreen'
  | 'nav.back'
  | 'nav.forward'

const isMac = process.platform === 'darwin'

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
export function buildAppMenu(getWindow: () => BrowserWindow | null): Menu {
  function emit(actionId: ShortcutActionId): void {
    const win = getWindow()
    win?.webContents.send('shortcut:fired', actionId)
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
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              {
                label: `Quit ${app.name}`,
                accelerator: 'CmdOrCtrl+Q',
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
          accelerator: 'CmdOrCtrl+N',
          click: (): void => emit('session.new')
        },
        {
          label: 'Add Folder…',
          accelerator: 'CmdOrCtrl+O',
          click: (): void => emit('folder.add')
        },
        { type: 'separator' },
        {
          label: 'Close Session',
          accelerator: 'CmdOrCtrl+W',
          // Soft-handled: T-4.5 will conditionally suppress this in the
          // renderer when the terminal pane has focus so xterm/Ctrl+W
          // forwards through to the PTY. Until then the renderer simply
          // closes the active tab.
          click: (): void => emit('session.close')
        },
        // On Linux/Windows the application menu also owns Quit (macOS has
        // it in the app menu above).
        ...((!isMac
          ? [
              { type: 'separator' },
              {
                label: 'Quit',
                accelerator: 'CmdOrCtrl+Q',
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
          accelerator: 'CmdOrCtrl+Shift+R',
          click: (): void => emit('session.resumeLast')
        },
        {
          label: 'Rename',
          accelerator: 'CmdOrCtrl+R',
          // The menu accelerator overrides the default Electron `reload`
          // binding for ⌘R, so we move reload to F5 in the View menu.
          click: (): void => emit('session.rename')
        },
        {
          label: 'Search',
          accelerator: 'CmdOrCtrl+K',
          click: (): void => emit('app.search')
        },
        {
          label: 'Switch Project…',
          accelerator: 'CmdOrCtrl+Shift+P',
          click: (): void => emit('project.switch')
        },
        { type: 'separator' },
        // Session navigation history (docs/specs/2026-10-06-session-nav-history.md
        // §5.3). The browser convention per platform: ⌘[ / ⌘] on macOS (⌥← is
        // word-jump in every macOS text field), Alt+← / Alt+→ elsewhere. On
        // Linux/Windows this accelerator only fires for a key the page left
        // unhandled, and xterm handles Alt+← / Alt+→, so the renderer stops the
        // chord in the capture phase before xterm sees it (App.vue `onNavKeydown`)
        // — accepted trade-off D-4: Alt+← / Alt+→ no longer reach the terminal.
        {
          label: 'Back',
          accelerator: isMac ? 'Cmd+[' : 'Alt+Left',
          click: (): void => emit('nav.back')
        },
        {
          label: 'Forward',
          accelerator: isMac ? 'Cmd+]' : 'Alt+Right',
          click: (): void => emit('nav.forward')
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
          accelerator: 'CmdOrCtrl+B',
          click: (): void => emit('view.toggleSidebar')
        },
        {
          label: 'Toggle Panel',
          accelerator: 'CmdOrCtrl+Alt+B',
          click: (): void => emit('view.toggleHelper')
        },
        { type: 'separator' },
        {
          label: 'Reload',
          accelerator: 'F5',
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
          accelerator: 'F12',
          click: (): void => {
            emit('app.devtools')
            const win = getWindow()
            win?.webContents.toggleDevTools()
          }
        },
        { type: 'separator' },
        {
          label: 'Toggle Fullscreen',
          accelerator: 'F11',
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
 */
export function registerAppMenu(getWindow: () => BrowserWindow | null): void {
  Menu.setApplicationMenu(buildAppMenu(getWindow))
}
