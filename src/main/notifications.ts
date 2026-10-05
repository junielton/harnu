import {
  ipcMain,
  Notification,
  type BrowserWindow,
  type NotificationConstructorOptions
} from 'electron'

/**
 * Main-process notifier (os-notifications spec §5). The renderer store makes the
 * *decision* (which transition, with what label — `session-notify.ts`) and sends
 * `notify:show`; main only *renders* the native `Notification` and, on click,
 * focuses the window and tells the renderer to select that session.
 *
 * `shouldShowNotification` / `buildNotificationOptions` are pure (no electron
 * state) so they're unit-tested; `registerNotifications` is the thin shell. The
 * app icon is injected by `index.ts` (which owns the `?asset` import) so this
 * module never pulls an electron-vite asset and stays node-loadable for tests.
 */

export interface NotifyPayload {
  title: string
  body?: string
  sessionId: string
  /**
   * Where a click should take the operator (T44 S4). Default (absent) selects
   * `sessionId`; `'inbox'` opens the Approval Inbox instead — for a parked MCP
   * confirm, which has no owning session to select.
   */
  activate?: 'inbox'
}

/**
 * Guard against an empty toast or an unsupported platform. Total over `unknown`
 * — `notify:show` is a fire-and-forget channel any renderer code can reach, so a
 * malformed payload (missing / non-string title) must no-op, never throw.
 * `supported` is passed in (not read from electron) so this stays pure/testable.
 */
export function shouldShowNotification(payload: unknown, supported: boolean): boolean {
  if (!supported) return false
  if (!payload || typeof payload !== 'object') return false
  const title = (payload as { title?: unknown }).title
  return typeof title === 'string' && title.trim().length > 0
}

/** Shape the native-notification options. Pure — no electron, no side effects. */
export function buildNotificationOptions(
  payload: { title: string; body?: string },
  iconPath: string
): NotificationConstructorOptions {
  return { title: payload.title, body: payload.body ?? '', icon: iconPath }
}

/**
 * Wire the `notify:show` channel. Fire-and-forget from the renderer; on click we
 * restore + focus the window and emit `notify:activate` so the store can select
 * the session.
 */
export function registerNotifications(
  getWindow: () => BrowserWindow | null,
  iconPath: string
): void {
  ipcMain.on('notify:show', (_e, payload: NotifyPayload) => {
    try {
      if (!shouldShowNotification(payload, Notification.isSupported())) return

      const n = new Notification(buildNotificationOptions(payload, iconPath))
      n.on('click', () => {
        const win = getWindow()
        if (!win || win.isDestroyed()) return
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
        // T44 S4: an inbox-activate confirm has no session to select — open the
        // Approval Inbox instead. Physically distinct channel from session-select.
        if (payload.activate === 'inbox') {
          win.webContents.send('notify:activate-inbox')
        } else {
          win.webContents.send('notify:activate', { sessionId: payload.sessionId })
        }
      })
      n.show()
    } catch (err) {
      // Never let a malformed payload or a platform notification fault escape
      // the IPC listener as an unhandled main-process exception.
      console.error('[notify] show failed', err)
    }
  })
}
