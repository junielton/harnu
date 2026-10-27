import { app, BrowserWindow, dialog, ipcMain, powerMonitor } from 'electron'
import { readFileSync, promises as fs } from 'node:fs'
import * as path from 'node:path'
import { getTaskStates } from './hook-bridge'
import {
  DEFAULT_QUIT_STRINGS,
  QUIT_DIALOG_MAX_NAMES,
  buildQuitDialogContent,
  decideQuitConfirm,
  normalizeQuitGuardPrefs,
  normalizeQuitStrings,
  resolveSessionNames,
  type QuitDialogStrings,
  type QuitGuardPrefs,
  type QuitReason
} from './quit-guard'

/**
 * T579 — electron shell of the quit guard. The decision and the dialog copy are pure
 * (`quit-guard.ts`); this file intercepts the window `close` event (X button) and
 * `before-quit` (Ctrl+Q / app menu), shows the native confirm, and persists "don't ask again".
 *
 * env-bound (electron + fs) ⇒ covered by the live check, per ADR-0001.
 */

/** How long to wait for the renderer's session names + translated copy before using the fallback. */
const RENDERER_REPLY_TIMEOUT_MS = 400

/** How long an updater restart keeps the guard bypassed before it re-arms. */
const UPDATE_BYPASS_TTL_MS = 30_000

let prefs: QuitGuardPrefs = normalizeQuitGuardPrefs(null)
/** Set by the updater's "Restart now" / the OS shutdown signal: this quit is never confirmed. */
let bypassReason: Exclude<QuitReason, 'user'> | null = null
/** The operator chose "Quit anyway" — every later close / before-quit of this quit passes. */
let approved = false
/** A dialog is already on screen; a second close / before-quit attempt must not stack another. */
let dialogOpen = false
let nextRequestId = 1

function prefsPath(): string {
  return path.join(app.getPath('userData'), 'quit-guard-prefs.json')
}

function persistPrefs(next: QuitGuardPrefs): void {
  prefs = next
  void fs
    .writeFile(prefsPath(), JSON.stringify(next, null, 2), 'utf8')
    .catch(() => undefined /* read-only userData — the in-memory value still applies */)
}

/**
 * The quit that follows is not a user quit (updater restart, OS shutdown) and must never be
 * blocked. Call BEFORE `autoUpdater.quitAndInstall()`.
 */
export function bypassQuitConfirm(reason: Exclude<QuitReason, 'user'>): void {
  bypassReason = reason
  // A restart that never happens (dev build, failed install) must not switch the guard off for
  // good. An OS shutdown ends the process, so it needs no expiry.
  if (reason === 'update-install') {
    setTimeout(() => {
      if (bypassReason === 'update-install') bypassReason = null
    }, UPDATE_BYPASS_TTL_MS).unref()
  }
}

/**
 * Call at the top of the window `close` handler and of `before-quit`. When it decides to ask,
 * it calls `event.preventDefault()` and shows the dialog; "Quit anyway" re-issues `app.quit()`,
 * which comes back through here already approved. Never throws: a failure must not trap the
 * operator in an app they cannot close.
 */
export function guardQuit(
  event: { preventDefault: () => void },
  getWindow: () => BrowserWindow | null
): void {
  try {
    if (approved) return
    const decision = decideQuitConfirm({
      taskStates: getTaskStates(),
      confirmEnabled: prefs.confirmOnQuit,
      reason: bypassReason ?? 'user'
    })
    if (!decision.confirm) return
    event.preventDefault()
    if (dialogOpen) return
    dialogOpen = true
    promptAndQuit(decision.sessionIds, getWindow())
      .catch((err) => {
        // The dialog itself failed: the operator asked to quit and must not be stuck in the app.
        console.error('[quit-guard] dialog failed — quitting without asking', err)
        approved = true
        app.quit()
      })
      .finally(() => {
        dialogOpen = false
      })
  } catch (err) {
    console.error('[quit-guard] failed — letting the quit through', err)
  }
}

async function promptAndQuit(sessionIds: string[], win: BrowserWindow | null): Promise<void> {
  const { labels, strings } = await askRenderer(win, sessionIds)
  const content = buildQuitDialogContent({
    appName: app.name,
    names: resolveSessionNames(sessionIds, labels),
    strings
  })
  const options = {
    type: 'warning' as const,
    title: app.name,
    message: content.message,
    detail: content.detail,
    buttons: content.buttons,
    defaultId: content.defaultId,
    cancelId: content.cancelId,
    checkboxLabel: content.checkboxLabel,
    checkboxChecked: false,
    noLink: true
  }
  const result =
    win && !win.isDestroyed()
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options)
  if (result.response === content.cancelId) return // Cancel: keep the app, window and PTYs alive
  if (result.checkboxChecked) persistPrefs({ ...prefs, confirmOnQuit: false })
  approved = true
  app.quit()
}

/**
 * Ask the renderer for readable session names and the translated dialog copy. It owns the i18n
 * catalogs and the session store; a hung or missing renderer just means short ids and English.
 */
function askRenderer(
  win: BrowserWindow | null,
  ids: string[]
): Promise<{ labels: Record<string, string>; strings: QuitDialogStrings }> {
  const fallback = { labels: {}, strings: DEFAULT_QUIT_STRINGS }
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return Promise.resolve(fallback)
  const requestId = nextRequestId++
  return new Promise((resolve) => {
    const finish = (value: typeof fallback): void => {
      clearTimeout(timer)
      ipcMain.removeListener('quitGuard:labelsReply', onReply)
      resolve(value)
    }
    const onReply = (_e: unknown, payload: unknown): void => {
      const p = payload as { requestId?: unknown; labels?: unknown; strings?: unknown } | null
      if (!p || p.requestId !== requestId) return
      const labels: Record<string, string> = {}
      if (p.labels && typeof p.labels === 'object') {
        for (const [id, label] of Object.entries(p.labels as Record<string, unknown>)) {
          if (typeof label === 'string') labels[id] = label
        }
      }
      finish({ labels, strings: normalizeQuitStrings(p.strings) })
    }
    const timer = setTimeout(() => finish(fallback), RENDERER_REPLY_TIMEOUT_MS)
    ipcMain.on('quitGuard:labelsReply', onReply)
    win.webContents.send('quitGuard:labelsRequest', {
      requestId,
      ids,
      maxNames: QUIT_DIALOG_MAX_NAMES
    })
  })
}

/** Register the prefs IPC, hydrate the cached pref, and watch for the OS shutdown signal. */
export function registerQuitConfirm(): void {
  try {
    prefs = normalizeQuitGuardPrefs(JSON.parse(readFileSync(prefsPath(), 'utf8')))
  } catch {
    /* no file / corrupt — keep the default (ask) */
  }
  ipcMain.handle('quit-guard:prefs', (): QuitGuardPrefs => prefs)
  ipcMain.handle('quit-guard:setPrefs', (_e, raw: unknown): QuitGuardPrefs => {
    persistPrefs(normalizeQuitGuardPrefs(raw))
    return prefs
  })
  // Never block a system shutdown / logout. A session manager's SIGTERM (and a dev Ctrl+C) reaches
  // `hook-bridge`'s exit handler, which calls `app.quit()` — prepend so the bypass is set before it.
  powerMonitor.on('shutdown', () => bypassQuitConfirm('system-shutdown'))
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.prependListener(sig, () => bypassQuitConfirm('system-shutdown'))
  }
}
