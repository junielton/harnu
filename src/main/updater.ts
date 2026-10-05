import { autoUpdater } from 'electron-updater'
import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { shouldSurfaceUpdaterError, usesManualUpdateFlow, releaseUrlFor } from './updater-policy'

/**
 * Module-level guard preventing `ipcMain.handle('updater:install', ...)`
 * from being registered twice when `registerUpdater()` is invoked more
 * than once (e.g. during dev HMR of the main process). `ipcMain.handle`
 * throws on duplicate channel registration, so a simple boolean flag
 * keeps the handler installed exactly once for the lifetime of the
 * process.
 */
let installHandlerRegistered = false

/**
 * Initialize electron-updater. Checks GitHub Releases for newer versions
 * 5 seconds after app ready, then once per hour. Notifies the renderer via
 * `updater:*` IPC events; the renderer (U-3.3) pushes a sticky "Update
 * ready" toast with a "Restart now" action that invokes `updater:install`.
 *
 * macOS and Windows builds are unsigned/unnotarized, so Gatekeeper /
 * Squirrel.Mac / Squirrel.Windows refuse to let electron-updater apply a
 * downloaded update silently there. On those platforms (`usesManualUpdateFlow`)
 * `autoDownload`/`autoInstallOnAppQuit` are left `false` and an
 * `update-available` instead emits `updater:manualAvailable` with a
 * version-tagged GitHub release-page URL, so the renderer can show a
 * "Download update" toast instead of the silent flow. Linux (AppImage) is
 * unaffected and keeps the existing silent download-and-restart.
 *
 * The `updater:install` IPC handler is registered regardless of `isPackaged`
 * so dev sessions can exercise the toast plumbing end-to-end (the handler
 * will just no-op because `autoUpdater` has nothing to install in dev — no
 * pending download was ever staged).
 *
 * Linux distribution caveat (see `findings/06-electron-packaging.md` §8):
 * electron-updater can only auto-update the **AppImage** target — the `.deb`
 * is owned by apt and cannot rewrite itself while running. We do not branch
 * on this at runtime; the updater itself detects the running format and
 * silently surfaces a "not available" path when launched from a `.deb`.
 * Documented in README + CLAUDE.md so the asymmetric Linux experience isn't
 * a surprise.
 */
export function registerUpdater(getWindow: () => BrowserWindow | null): void {
  // The install IPC is wired even in dev so the renderer's action handler
  // can be invoked without a runtime check on `app.isPackaged`. In dev the
  // call will simply quit-and-restart the unpackaged binary; the toast
  // itself is only shown in response to `updater:downloaded`, which never
  // fires in dev because the rest of this function early-returns below.
  if (!installHandlerRegistered) {
    ipcMain.handle('updater:install', () => {
      autoUpdater.quitAndInstall()
    })
    installHandlerRegistered = true
  }

  // Use require() rather than `import { app }` so the preload's typecheck
  // pass (tsc -p tsconfig.node.json) does not pull the electron-updater
  // type graph into the preload bundle — electron-updater is main-process
  // only and resolves at runtime.
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- main-only, see note above
  if (!require('electron').app.isPackaged) return

  // electron-updater builds its AppUpdater lazily on first `autoUpdater` access
  // and VALIDATES app.version as strict semver in the constructor — an invalid
  // version (e.g. a stray "0.2.01") throws synchronously here. Because this runs
  // inside app.whenReady()'s async chain, an uncaught throw becomes an unhandled
  // promise rejection at startup. Guard the whole setup so a misconfigured
  // updater degrades to "no auto-update" instead of destabilising boot.
  const manualFlow = usesManualUpdateFlow(process.platform)
  try {
    autoUpdater.autoDownload = !manualFlow
    autoUpdater.autoInstallOnAppQuit = !manualFlow
  } catch (err) {
    console.warn('[updater] disabled — init failed:', String(err))
    return
  }

  const send = (channel: string, payload?: unknown): void => {
    getWindow()?.webContents.send(channel, payload)
  }

  // Tracks whether the current cycle ever found an update. Gates error
  // surfacing: a failure BEFORE any `update-available` is a benign
  // background-check failure (first-run 404, offline) and must not alarm the
  // user; a failure AFTER is a download/install error worth a toast.
  let updateWasAvailable = false

  autoUpdater.on('update-available', (info) => {
    updateWasAvailable = true
    send('updater:available', info)
    if (manualFlow) {
      send('updater:manualAvailable', {
        version: info.version,
        releaseUrl: releaseUrlFor(info.version)
      })
    }
  })
  autoUpdater.on('update-not-available', () => send('updater:none'))
  autoUpdater.on('download-progress', (p) => send('updater:progress', p))
  autoUpdater.on('update-downloaded', (info) => send('updater:downloaded', info))
  autoUpdater.on('error', (err) => {
    if (shouldSurfaceUpdaterError(updateWasAvailable)) {
      send('updater:error', { message: String(err) })
    } else {
      // Benign check-phase failure — log for diagnostics, don't toast.
      console.warn('[updater] background check failed (suppressed):', String(err))
    }
  })

  // Initial check + hourly poll. `checkForUpdatesAndNotify` is the safe entry
  // point — it shows the OS-native "Update available" notification if the
  // renderer hasn't reacted yet. We swallow errors here (no network, GitHub
  // 404 on the very first release, etc.) so they don't surface as uncaught
  // promise rejections; the `error` event above is what the UI consumes.
  setTimeout(() => {
    autoUpdater.checkForUpdatesAndNotify().catch(() => {})
  }, 5000)
  setInterval(
    () => {
      autoUpdater.checkForUpdatesAndNotify().catch(() => {})
    },
    60 * 60 * 1000
  )
}
