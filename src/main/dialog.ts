import { ipcMain, dialog, BrowserWindow } from 'electron'

/**
 * Register the renderer-facing dialog channels. Currently exposes a single
 * `dialog:openDirectory` channel that drives Electron's native directory
 * picker via `dialog.showOpenDialog`.
 *
 * The handler always parents the dialog to the main window so the OS treats
 * it as modal to the app — without this, on Linux the picker can end up
 * behind the main window and on macOS the app loses focus.
 *
 * The reply shape `{ path: string | null }` is intentionally an object (not
 * a bare `string | null`) so we can grow it later (e.g. add `recent: string[]`
 * or `canceled: true` flags) without a breaking IPC change.
 */
export function registerDialogHandlers(getWindow: () => BrowserWindow | null): void {
  // The markdown open/create flow no longer uses a native file dialog — opening
  // is via the in-app Explorer pane (Cluster E), and new files are created there
  // through the confined `markdown:write`. On Linux/Wayland the XDG portal
  // ignored Electron's `defaultPath` and opened far from the project, so the
  // former `dialog:openFile` / `dialog:saveFile` channels were retired.
  ipcMain.handle('dialog:openDirectory', async (): Promise<{ path: string | null }> => {
    const win = getWindow()
    // Without a window we still resolve, just unparented. `showOpenDialog`
    // tolerates `undefined` for the first arg.
    const result = win
      ? await dialog.showOpenDialog(win, {
          // `openDirectory` is the universal property; `createDirectory` is
          // macOS-only but harmless on other platforms.
          properties: ['openDirectory', 'createDirectory']
        })
      : await dialog.showOpenDialog({
          properties: ['openDirectory', 'createDirectory']
        })
    if (result.canceled || result.filePaths.length === 0) return { path: null }
    return { path: result.filePaths[0] }
  })
}
