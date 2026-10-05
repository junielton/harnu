import { app, ipcMain, type BrowserWindow } from 'electron'

/**
 * OS window-attention primitive (T44 S4): flash the taskbar entry / bounce the
 * dock so a parked confirm (or any away-time attention need) pulls the operator
 * back even when Harnu isn't focused. The decidable part (`attentionStrategy`) is
 * pure + unit-tested (`tests/window-attention.test.ts`); `registerWindowAttention`
 * is the electron glue. Best-effort: an unsupported / focused environment no-ops
 * gracefully (the badge + window title are the universal signals). Never throws.
 *
 * Fires on `window:requestAttention` (renderer → main, fire-and-forget). Guarded:
 * a focused window is skipped (the operator is already here).
 */

export type AttentionStrategy = 'flash' | 'bounce' | 'none'

/** Pure: which attention path this OS uses. */
export function attentionStrategy(platform: NodeJS.Platform): AttentionStrategy {
  if (platform === 'win32' || platform === 'linux') return 'flash'
  if (platform === 'darwin') return 'bounce'
  return 'none'
}

export function registerWindowAttention(getWindow: () => BrowserWindow | null): void {
  ipcMain.on('window:requestAttention', () => {
    try {
      const strat = attentionStrategy(process.platform)
      if (strat === 'bounce') {
        // macOS: bounce the dock icon once (informational — stops on focus).
        app.dock?.bounce('informational')
        return
      }
      if (strat === 'flash') {
        const win = getWindow()
        // Already here → nothing to pull. Only flash when unfocused.
        if (!win || win.isDestroyed() || win.isFocused()) return
        win.flashFrame(true)
        // Clear the flash when the operator returns.
        win.once('focus', () => {
          if (!win.isDestroyed()) win.flashFrame(false)
        })
      }
      // 'none' → graceful no-op
    } catch (err) {
      console.error('[window-attention] request failed', err)
    }
  })
}
